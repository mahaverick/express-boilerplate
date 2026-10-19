/**
 * @file Integration test of `EmailLinkTokenRepository` against the real
 * per-worker Postgres database. Every address this file writes starts with
 * its own prefix, and `afterEach` deletes those rows and the users it made
 * (whose `step_up` rows cascade).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { LinkTokenIntent, NewEmailLinkToken } from '@/database/models/email-link-token.model'
import { EmailLinkTokenRepository } from '@/repositories/email-link-token.repository'
import { db, sql } from '@/services/database.service'

const repo = new EmailLinkTokenRepository()
const PREFIX = `link-repo-${randomUUID()}-`
const userIds: string[] = []
const PREFIX_LIKE = `${PREFIX}%`

afterEach(async () => {
  await sql`delete from email_link_tokens where email like ${PREFIX_LIKE}`
  if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
  userIds.length = 0
})

/**
 * An expiry an hour from now.
 */
function inAnHour(): Date {
  return new Date(Date.now() + 3_600_000)
}

/**
 * A fresh address under the file's prefix.
 */
function address(): string {
  return `${PREFIX}${randomUUID()}@example.test`
}

/**
 * A fresh 64-character lowercase hex string standing in for a token digest.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
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
 * A live `sign_in` row's values, with `overrides` merged over them.
 */
function signInRow(overrides: Partial<NewEmailLinkToken> = {}): NewEmailLinkToken {
  return {
    intent: 'sign_in',
    app: 'web',
    email: address(),
    tokenHash: uniqueHash(),
    expiresAt: inAnHour(),
    ...overrides,
  }
}

/**
 * A live `step_up` row's values for one user and session, with `overrides` merged over them.
 */
function stepUpRow(
  userId: string,
  sessionId: string,
  overrides: Partial<NewEmailLinkToken> = {}
): NewEmailLinkToken {
  return {
    intent: 'step_up',
    app: 'apex',
    email: address(),
    userId,
    sessionId,
    tokenHash: uniqueHash(),
    expiresAt: inAnHour(),
    ...overrides,
  }
}

/**
 * A row's `revoked_at` and `consumed_at`, read by id.
 */
async function stateOf(
  id: string
): Promise<{ revoked_at: string | null; consumed_at: string | null } | undefined> {
  const [row] = await sql<{ revoked_at: string | null; consumed_at: string | null }[]>`
    select revoked_at, consumed_at from email_link_tokens where id = ${id}`
  return row
}

/**
 * The id `claimOnce` claims, or undefined when it claims nothing.
 */
async function claimedId(
  hash: string,
  intent: LinkTokenIntent,
  bound?: { userId: string; sessionId: string }
): Promise<string | undefined> {
  const row = await repo.claimOnce(hash, intent, bound)
  return row?.id
}

/**
 * A row's `revoked_at`, read by id: null while it is live.
 */
async function revokedAtOf(id: string): Promise<string | null | undefined> {
  const state = await stateOf(id)
  return state?.revoked_at
}

/**
 * Which of `ids` still exist, sorted.
 */
async function surviving(ids: string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from email_link_tokens where id = any(${ids})`
  return sorted(rows.map((row) => row.id))
}

/**
 * Ids sorted the way `surviving` returns them.
 */
function sorted(ids: string[]): string[] {
  return ids.toSorted((a, b) => a.localeCompare(b))
}

describe('EmailLinkTokenRepository', () => {
  it('claims a live row once and never twice', async () => {
    const hashA = uniqueHash()
    const row = await repo.insert(signInRow({ tokenHash: hashA }))
    expect(await claimedId(hashA, 'sign_in')).toBe(row.id)
    expect(await repo.claimOnce(hashA, 'sign_in')).toBeUndefined()
    const state = await stateOf(row.id)
    expect(state?.revoked_at).not.toBeNull()
    expect(state?.consumed_at).not.toBeNull()
  })

  it('claims an expired row, leaving the expiry to the caller', async () => {
    const hash = uniqueHash()
    const row = await repo.insert(signInRow({ tokenHash: hash, expiresAt: new Date(0) }))
    expect(await claimedId(hash, 'sign_in')).toBe(row.id)
  })

  it('never claims a sign_in row as step_up', async () => {
    const hash = uniqueHash()
    const row = await repo.insert(signInRow({ tokenHash: hash }))
    expect(await repo.claimOnce(hash, 'step_up')).toBeUndefined()
    // eslint-disable-next-line unicorn/no-null -- SQL NULL: the row is still live
    expect(await stateOf(row.id)).toEqual({ revoked_at: null, consumed_at: null })
  })

  it('claims a step_up row only for its own user and session', async () => {
    const userId = await insertUser()
    const otherUserId = await insertUser()
    const sessionId = randomUUID()
    const hash = uniqueHash()
    const row = await repo.insert(stepUpRow(userId, sessionId, { tokenHash: hash }))

    expect(await claimedId(hash, 'step_up', { userId, sessionId: randomUUID() })).toBeUndefined()
    expect(await claimedId(hash, 'step_up', { userId: otherUserId, sessionId })).toBeUndefined()
    // eslint-disable-next-line unicorn/no-null -- SQL NULL: the wrong session spent nothing
    expect(await stateOf(row.id)).toEqual({ revoked_at: null, consumed_at: null })

    expect(await claimedId(hash, 'step_up', { userId, sessionId })).toBe(row.id)
  })

  it('peeks without spending', async () => {
    const hash = uniqueHash()
    const row = await repo.insert(signInRow({ tokenHash: hash }))
    const first = await repo.findLiveByHash(hash, 'sign_in')
    const again = await repo.findLiveByHash(hash, 'sign_in')
    expect(first?.id).toBe(row.id)
    expect(again?.id).toBe(row.id)
    expect(again?.consumedAt).toBeNull()
    expect(await repo.findLiveByHash(hash, 'step_up')).toBeUndefined()
  })

  it('peeks past nothing expired or revoked', async () => {
    const expired = uniqueHash()
    const aSecondAgo = new Date(Date.now() - 1000)
    await repo.insert(signInRow({ tokenHash: expired, expiresAt: aSecondAgo }))
    const revoked = uniqueHash()
    await repo.insert(signInRow({ tokenHash: revoked, revokedAt: new Date() }))
    const claimed = uniqueHash()
    await repo.insert(signInRow({ tokenHash: claimed }))
    await repo.claimOnce(claimed, 'sign_in')

    expect(await repo.findLiveByHash(expired, 'sign_in')).toBeUndefined()
    expect(await repo.findLiveByHash(revoked, 'sign_in')).toBeUndefined()
    expect(await repo.findLiveByHash(claimed, 'sign_in')).toBeUndefined()
  })

  it('revokes only the live sign_in rows of one address', async () => {
    const email = address()
    const first = await repo.insert(signInRow({ email }))
    const second = await repo.insert(signInRow({ email, app: 'apex' }))
    const otherAddress = await repo.insert(signInRow())
    const userId = await insertUser()
    const stepUp = await repo.insert(stepUpRow(userId, randomUUID(), { email }))

    expect(await repo.revokeLiveFor({ email: email.toUpperCase(), intent: 'sign_in' })).toBe(2)

    const firstState = await stateOf(first.id)
    expect(firstState?.revoked_at).not.toBeNull()
    expect(firstState?.consumed_at).toBeNull()
    expect(await revokedAtOf(second.id)).not.toBeNull()
    expect(await revokedAtOf(otherAddress.id)).toBeNull()
    expect(await revokedAtOf(stepUp.id)).toBeNull()
    expect(await repo.revokeLiveFor({ email, intent: 'sign_in' })).toBe(0)
  })

  it('revokes only the live step_up rows of one session', async () => {
    const userId = await insertUser()
    const sessionId = randomUUID()
    const mine = await repo.insert(stepUpRow(userId, sessionId))
    const otherSession = await repo.insert(stepUpRow(userId, randomUUID()))

    expect(await repo.revokeLiveFor({ userId, sessionId, intent: 'step_up' })).toBe(1)

    expect(await revokedAtOf(mine.id)).not.toBeNull()
    expect(await revokedAtOf(otherSession.id)).toBeNull()
  })

  it('purges rows expired or revoked-unconsumed before the cutoff', async () => {
    const cutoff = new Date('1991-01-01T00:00:00.000Z')
    const before = new Date('1990-06-01T00:00:00.000Z')
    const after = new Date('1991-06-01T00:00:00.000Z')
    const expiredOld = await repo.insert(signInRow({ expiresAt: before }))
    const expiredNew = await repo.insert(signInRow({ expiresAt: after }))
    const killedOld = await repo.insert(signInRow({ expiresAt: inAnHour(), revokedAt: before }))
    const spentOld = await repo.insert(
      signInRow({ expiresAt: inAnHour(), revokedAt: before, consumedAt: before })
    )

    const deleted = await db.transaction((tx) => repo.purgeExpiredOrRevokedBefore(cutoff, 100, tx))

    expect(deleted).toBe(2)
    expect(await surviving([expiredOld.id, expiredNew.id, killedOld.id, spentOld.id])).toEqual(
      sorted([expiredNew.id, spentOld.id])
    )
  })

  it('deletes every row for an address up to a moment, whatever its case', async () => {
    const email = address()
    const old = await repo.insert(signInRow({ email }))
    await sql`update email_link_tokens set created_at = now() - interval '2 hours' where id = ${old.id}`
    const recent = await repo.insert(signInRow({ email }))
    const other = await repo.insert(signInRow())
    const anHourAgo = new Date(Date.now() - 3_600_000)

    const deleted = await db.transaction((tx) =>
      repo.deleteForEmail(email.toUpperCase(), anHourAgo, tx)
    )

    expect(deleted).toBe(1)
    expect(await surviving([old.id, recent.id, other.id])).toEqual(sorted([recent.id, other.id]))
  })
})
