/**
 * @file Integration test of the link-token service against the real
 * per-worker Postgres database: what is stored, the revoke-on-issue, the
 * claim's expiry rule, the read-only peek and the URLs a mail carries.
 * APEX_URL is mocked onto the environment, since `.env.test` leaves it
 * unset and `frontendUrl('apex')` would then fall back to WEB_URL.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { LinkTokenIntent } from '@/database/models/email-link-token.model'
import { sql } from '@/services/database.service'
import {
  buildSignInLinkUrl,
  buildStepUpConfirmUrl,
  claimLinkToken,
  issueLinkToken,
  peekLinkToken,
  type IssueLinkTokenInput,
} from '@/services/link-token.service'

// Hoisted with the mock below, which reads it.
const { APEX } = vi.hoisted(() => ({ APEX: 'https://apex.link-token.test' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), APEX_URL: APEX }) }
})

const PREFIX = `link-svc-${randomUUID()}-`
const PREFIX_LIKE = `${PREFIX}%`
const userIds: string[] = []
const TTL_MS = 15 * 60_000

afterEach(async () => {
  await sql`delete from email_link_tokens where email like ${PREFIX_LIKE}`
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * A fresh address under the file's prefix.
 */
function address(): string {
  return `${PREFIX}${randomUUID()}@example.test`
}

/**
 * The hex SHA-256 of a raw token, computed here rather than by the service under test.
 */
function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Inserts a user with raw SQL, tracked for cleanup, and returns its id.
 */
async function insertUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email) values (${address()}) returning id`
  if (!row) throw new Error('user insert returned no row')
  userIds.push(row.id)
  return row.id
}

/**
 * The id `claimLinkToken` claims, or undefined when it answers undefined.
 */
async function claimedId(
  raw: string,
  intent: LinkTokenIntent,
  bound?: { userId: string; sessionId: string }
): Promise<string | undefined> {
  const row = await claimLinkToken(raw, intent, bound)
  return row?.id
}

/**
 * A web sign-in request for a fresh address, with `overrides` merged over it.
 */
function signIn(overrides: Partial<IssueLinkTokenInput> = {}): IssueLinkTokenInput {
  return { intent: 'sign_in', email: address(), app: 'web', ...overrides }
}

describe('issueLinkToken', () => {
  it('stores only the SHA-256 of a 43-character base64url token', async () => {
    const { raw, row } = await issueLinkToken(signIn(), TTL_MS)

    expect(raw).toMatch(/^[\w-]{43}$/)
    expect(row.tokenHash).toBe(sha256hex(raw))
    const stored = await sql<{ token_hash: string }[]>`
      select token_hash from email_link_tokens where id = ${row.id}`
    expect(stored).toEqual([{ token_hash: sha256hex(raw) }])
  })

  it('stores the address lowercased and the expiry ttl from now', async () => {
    const email = address()
    const before = Date.now()
    const { row } = await issueLinkToken(signIn({ email: email.toUpperCase() }), TTL_MS)

    expect(row.email).toBe(email.toLowerCase())
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TTL_MS)
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TTL_MS)
  })

  it('revokes the previous unused sign-in link for the address when issuing a new one', async () => {
    const email = address()
    const first = await issueLinkToken(signIn({ email }), TTL_MS)
    const other = await issueLinkToken(signIn(), TTL_MS)
    const second = await issueLinkToken(signIn({ email: email.toUpperCase() }), TTL_MS)

    expect(await claimLinkToken(first.raw, 'sign_in')).toBeUndefined()
    expect(await claimedId(other.raw, 'sign_in')).toBe(other.row.id)
    expect(await claimedId(second.raw, 'sign_in')).toBe(second.row.id)
  })

  it('leaves one live sign-in link when several are issued for an address at once', async () => {
    // Several rounds: one round without the issue lock only sometimes interleaves.
    for (let round = 0; round < 5; round += 1) {
      const email = address()
      await Promise.all(Array.from({ length: 5 }, () => issueLinkToken(signIn({ email }), TTL_MS)))

      const live = await sql`
        select 1 from email_link_tokens where email = ${email} and revoked_at is null`
      expect(live).toHaveLength(1)
    }
  })

  it('revokes the previous step-up link of the same session only', async () => {
    const userId = await insertUser()
    const sessionId = randomUUID()
    /**
     * A step-up request for this user and one session.
     */
    function stepUp(sid: string): IssueLinkTokenInput {
      return { intent: 'step_up', email: address(), app: 'apex', userId, sessionId: sid }
    }
    const otherSessionId = randomUUID()
    const first = await issueLinkToken(stepUp(sessionId), TTL_MS)
    const otherSession = await issueLinkToken(stepUp(otherSessionId), TTL_MS)
    const second = await issueLinkToken(stepUp(sessionId), TTL_MS)

    expect(await claimLinkToken(first.raw, 'step_up', { userId, sessionId })).toBeUndefined()
    const bound = { userId, sessionId: otherSessionId }
    expect(await claimedId(otherSession.raw, 'step_up', bound)).toBe(otherSession.row.id)
    expect(await claimedId(second.raw, 'step_up', { userId, sessionId })).toBe(second.row.id)
  })

  it('refuses a step_up issue without its user and session, writing nothing', async () => {
    const email = address()
    await expect(
      issueLinkToken({ intent: 'step_up', email, app: 'apex' }, TTL_MS)
    ).rejects.toThrow()
    expect(await sql`select 1 from email_link_tokens where email = ${email}`).toHaveLength(0)
  })
})

describe('claimLinkToken', () => {
  it('spends an expired link and answers undefined', async () => {
    const { raw, row } = await issueLinkToken(signIn(), TTL_MS)
    await sql`update email_link_tokens set expires_at = now() - interval '1 second' where id = ${row.id}`

    expect(await claimLinkToken(raw, 'sign_in')).toBeUndefined()
    const [state] = await sql<{ consumed_at: string | null }[]>`
      select consumed_at from email_link_tokens where id = ${row.id}`
    expect(state?.consumed_at).not.toBeNull()
  })

  it('answers undefined for a token never issued', async () => {
    expect(await claimLinkToken('x'.repeat(43), 'sign_in')).toBeUndefined()
  })
})

describe('peekLinkToken', () => {
  it('reads a live link without spending it', async () => {
    const { raw, row } = await issueLinkToken(signIn({ redirect: '/tenants' }), TTL_MS)

    const peeked = await peekLinkToken(raw, 'sign_in')
    expect(peeked?.redirect).toBe('/tenants')
    expect(await peekLinkToken(raw, 'step_up')).toBeUndefined()
    expect(await claimedId(raw, 'sign_in')).toBe(row.id)
    expect(await peekLinkToken(raw, 'sign_in')).toBeUndefined()
  })
})

describe('link URLs', () => {
  it('builds a link carrying token, email and redirect on the app origin', () => {
    const raw = 'a'.repeat(43)
    const email = 'person+tag@example.test'
    const redirect = '/tenants/acme/members?tenant=acme&tab=2#x'

    const apexUrl = new URL(buildSignInLinkUrl(raw, { email, app: 'apex', redirect }))
    expect(apexUrl.origin).toBe(APEX)
    expect(apexUrl.pathname).toBe('/auth/link')
    expect(apexUrl.searchParams.get('token')).toBe(raw)
    expect(apexUrl.searchParams.get('email')).toBe(email)
    expect(apexUrl.searchParams.get('redirect')).toBe(redirect)
    expect(apexUrl.hash).toBe('')

    // eslint-disable-next-line unicorn/no-null -- a row with no stored redirect
    const webUrl = new URL(buildSignInLinkUrl(raw, { email, app: 'web', redirect: null }))
    expect(webUrl.origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(webUrl.origin).not.toBe(APEX)
    expect(webUrl.pathname).toBe('/auth/link')
    expect(webUrl.searchParams.get('token')).toBe(raw)
    expect(webUrl.searchParams.get('email')).toBe(email)
    expect(webUrl.searchParams.has('redirect')).toBe(false)
  })

  it('builds the step-up confirm link on the apex origin', () => {
    const raw = 'b'.repeat(43)
    const url = new URL(buildStepUpConfirmUrl(raw))
    expect(url.origin).toBe(APEX)
    expect(url.pathname).toBe('/auth/confirm')
    // The token is the only parameter.
    expect(url.search).toBe(`?token=${raw}`)
  })
})
