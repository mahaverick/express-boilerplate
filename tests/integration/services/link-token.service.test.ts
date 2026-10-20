/**
 * @file Integration test of the link-token service against the real
 * per-worker Postgres database (the link rows of `user_tokens`): what is stored, the revoke-on-issue, the
 * claim's expiry rule, the read-only peek and the URLs a mail carries.
 * APEX_URL is mocked onto the environment, since `.env.test` leaves it
 * unset and `frontendUrl('apex')` would then fall back to WEB_URL.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { LinkTokenIntent } from '@/database/models/user-token.model'
import { db, sql } from '@/services/database.service'
import {
  buildInvitationConfirmUrl,
  buildSignInLinkUrl,
  buildStepUpConfirmUrl,
  claimLinkToken,
  issueLinkToken,
  peekLinkToken,
  type IssueLinkTokenInput,
} from '@/services/link-token.service'
import { revokeSignInLinksOf } from '@/services/session.service'

// Hoisted with the mock below, which reads it.
const { APEX } = vi.hoisted(() => ({ APEX: 'https://apex.link-token.test' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), APEX_URL: APEX }) }
})

const PREFIX = `link-svc-${randomUUID()}-`
const PREFIX_LIKE = `${PREFIX}%`
const userIds: string[] = []
const tenantIds: string[] = []
const TTL_MS = 15 * 60_000

afterEach(async () => {
  await sql`delete from user_tokens where email like ${PREFIX_LIKE}`
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
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
 * Alphabetical order, for comparing id lists.
 */
function byText(a: string, b: string): number {
  return a.localeCompare(b)
}

/**
 * Inserts a tenant and a pending invitation in it with raw SQL, tracked for
 * cleanup, and returns the invitation's id.
 */
async function insertInvitation(email: string): Promise<string> {
  const inviterId = await insertUser()
  const slug = `${PREFIX}${randomUUID()}`
  const [tenant] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Acme Inc', ${slug}) returning id`
  if (!tenant) throw new Error('tenant insert returned no row')
  tenantIds.push(tenant.id)
  const [invitation] = await sql<{ id: string }[]>`
    insert into tenant_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    values (${tenant.id}, ${email}, 'editor', ${sha256hex(randomUUID())}, ${inviterId},
      now() + interval '3 days')
    returning id`
  if (!invitation) throw new Error('invitation insert returned no row')
  return invitation.id
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
      select token_hash from user_tokens where id = ${row.id}`
    expect(stored).toEqual([{ token_hash: sha256hex(raw) }])
  })

  it('keys a sign-in link by address, with no user or session', async () => {
    const { row } = await issueLinkToken(signIn({ app: 'apex', redirect: '/tenants' }), TTL_MS)
    const [stored] = await sql<Record<string, unknown>[]>`
      select purpose, user_id, session_id, app, redirect from user_tokens where id = ${row.id}`
    expect(stored).toEqual({
      purpose: 'sign_in_link',
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: a sign-in link names no user
      user_id: null,
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: nor a session
      session_id: null,
      app: 'apex',
      redirect: '/tenants',
    })
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
        select 1 from user_tokens where email = ${email} and revoked_at is null`
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

  it('keys an invitation link by address and invitation, and revokes only the address’s earlier invitation link', async () => {
    const email = address()
    const invitationId = await insertInvitation(email)
    const signInLink = await issueLinkToken(signIn({ email }), TTL_MS)
    const first = await issueLinkToken(
      { intent: 'invitation', email, app: 'web', invitationId },
      TTL_MS
    )
    const second = await issueLinkToken(
      { intent: 'invitation', email: email.toUpperCase(), app: 'web', invitationId },
      TTL_MS
    )

    const [stored] = await sql<Record<string, unknown>[]>`
      select purpose, user_id, session_id, redirect, invitation_id from user_tokens
      where id = ${second.row.id}`
    expect(stored).toEqual({
      purpose: 'invitation_link',
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: an invitation link names no user
      user_id: null,
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: nor a session
      session_id: null,
      // eslint-disable-next-line unicorn/no-null -- SQL NULL: nor a redirect
      redirect: null,
      invitation_id: invitationId,
    })
    expect(await claimLinkToken(first.raw, 'invitation')).toBeUndefined()
    // Another intent's link of the same address is left alone, and never claims as this one.
    expect(await claimLinkToken(signInLink.raw, 'invitation')).toBeUndefined()
    expect(await claimedId(signInLink.raw, 'sign_in')).toBe(signInLink.row.id)
    expect(await claimedId(second.raw, 'invitation')).toBe(second.row.id)
  })

  it('keeps a live confirm link per invitation, and the address-wide revoke ends them all', async () => {
    const email = address()
    const first = await insertInvitation(email)
    const second = await insertInvitation(email)
    const linkA = await issueLinkToken(
      { intent: 'invitation', email, app: 'web', invitationId: first },
      TTL_MS
    )
    const linkB = await issueLinkToken(
      { intent: 'invitation', email, app: 'web', invitationId: second },
      TTL_MS
    )

    const live = await sql<{ id: string }[]>`
      select id from user_tokens
      where email = ${email} and purpose = 'invitation_link' and revoked_at is null
      order by id`
    expect(live.map((row) => row.id).toSorted(byText)).toEqual(
      [linkA.row.id, linkB.row.id].toSorted(byText)
    )

    await db.transaction((tx) => revokeSignInLinksOf(email, tx))

    expect(await claimLinkToken(linkA.raw, 'invitation')).toBeUndefined()
    expect(await claimLinkToken(linkB.raw, 'invitation')).toBeUndefined()
  })

  it('refuses an invitation issue without its invitation, writing nothing', async () => {
    const email = address()
    await expect(
      issueLinkToken({ intent: 'invitation', email, app: 'web' }, TTL_MS)
    ).rejects.toThrow('An invitation link needs its invitation')
    expect(await sql`select 1 from user_tokens where email = ${email}`).toHaveLength(0)
  })

  it('refuses a step_up issue without its user and session, writing nothing', async () => {
    const email = address()
    await expect(
      issueLinkToken({ intent: 'step_up', email, app: 'apex' }, TTL_MS)
    ).rejects.toThrow()
    expect(await sql`select 1 from user_tokens where email = ${email}`).toHaveLength(0)
  })
})

describe('claimLinkToken', () => {
  it('spends an expired link and answers undefined', async () => {
    const { raw, row } = await issueLinkToken(signIn(), TTL_MS)
    await sql`update user_tokens set expires_at = now() - interval '1 second' where id = ${row.id}`

    expect(await claimLinkToken(raw, 'sign_in')).toBeUndefined()
    const [state] = await sql<{ consumed_at: string | null }[]>`
      select consumed_at from user_tokens where id = ${row.id}`
    expect(state?.consumed_at).not.toBeNull()
  })

  it('never honours or spends a step-up link presented without its session', async () => {
    const userId = await insertUser()
    const sessionId = randomUUID()
    const { raw, row } = await issueLinkToken(
      { intent: 'step_up', email: address(), app: 'apex', userId, sessionId },
      TTL_MS
    )

    expect(await claimLinkToken(raw, 'step_up')).toBeUndefined()
    expect(await claimedId(raw, 'step_up', { userId, sessionId })).toBe(row.id)
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

    const apexUrl = new URL(
      buildSignInLinkUrl(raw, { email, app: 'apex', redirect }, 'sign_in_link')
    )
    expect(apexUrl.origin).toBe(APEX)
    expect(apexUrl.pathname).toBe('/auth/link')
    expect(apexUrl.searchParams.get('token')).toBe(raw)
    expect(apexUrl.searchParams.get('email')).toBe(email)
    expect(apexUrl.searchParams.get('redirect')).toBe(redirect)
    expect(apexUrl.hash).toBe('')

    const webUrl = new URL(
      // eslint-disable-next-line unicorn/no-null -- a row with no stored redirect
      buildSignInLinkUrl(raw, { email, app: 'web', redirect: null }, 'sign_in_link')
    )
    expect(webUrl.origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(webUrl.origin).not.toBe(APEX)
    expect(webUrl.pathname).toBe('/auth/link')
    expect(webUrl.searchParams.get('token')).toBe(raw)
    expect(webUrl.searchParams.get('email')).toBe(email)
    expect(webUrl.searchParams.has('redirect')).toBe(false)
  })

  it('builds the invitation confirm link with token and email on the row’s app origin', () => {
    const raw = 'c'.repeat(43)
    const email = 'grace+tag@example.test'
    const apexUrl = new URL(buildInvitationConfirmUrl(raw, { email, app: 'apex' }))
    expect(apexUrl.origin).toBe(APEX)
    expect(apexUrl.pathname).toBe('/invitations/confirm')
    expect(apexUrl.searchParams.get('token')).toBe(raw)
    expect(apexUrl.searchParams.get('email')).toBe(email)
    expect(apexUrl.searchParams.get('utm_campaign')).toBe('invitation_confirm')
    expect(apexUrl.searchParams.get('utm_content')).toBe('primary_button')
    const webUrl = new URL(buildInvitationConfirmUrl(raw, { email, app: 'web' }))
    expect(webUrl.origin).toBe(new URL(getEnv().WEB_URL).origin)
    // eslint-disable-next-line unicorn/no-null -- a row with no app, which no link row is
    expect(() => buildInvitationConfirmUrl(raw, { email, app: null })).toThrow()
    // eslint-disable-next-line unicorn/no-null -- a row with no address, which no link row is
    expect(() => buildInvitationConfirmUrl(raw, { email: null, app: 'web' })).toThrow()
  })

  it('builds the step-up confirm link on the origin of the app that asked', () => {
    const raw = 'b'.repeat(43)
    const web = new URL(buildStepUpConfirmUrl(raw, 'web'))
    expect(web.origin).toBe(new URL(getEnv().WEB_URL).origin)
    expect(web.pathname).toBe('/auth/confirm')
    const url = new URL(buildStepUpConfirmUrl(raw, 'apex'))
    expect(url.origin).toBe(APEX)
    expect(url.pathname).toBe('/auth/confirm')
    // The token comes first; UTM parameters follow.
    expect(url.searchParams.get('token')).toBe(raw)
  })
})
