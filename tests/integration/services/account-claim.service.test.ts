/**
 * @file `claimNeverVerifiedAccount` re-checks the account under its lock: an
 * account verified after the caller's check (a concurrent claim that won)
 * is returned as it is, with no `inLock` write, no session revoked and no
 * `email_verified` emitted, so the mailbox owner's new link and session
 * survive.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { claimNeverVerifiedAccount } from '@/services/account-claim.service'
import { sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { issueRefreshToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'

const authProviderRepository = new AuthProviderRepository()

/**
 * The users `email_verified` was emitted for while this file runs.
 */
const verifiedUserIds: string[] = []
subscribeDomainEvent('email_verified', (event) => {
  verifiedUserIds.push(event.userId)
})

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

describe('claimNeverVerifiedAccount', () => {
  it('leaves an account verified by the time it locks untouched', async () => {
    const user = await createTrackedUser({ verified: true })
    const googleId = randomUUID()
    await authProviderRepository.create({
      userId: user.id,
      provider: 'google',
      providerId: googleId,
    })
    await issueRefreshToken(user.id, randomUUID())
    const inLock = vi.fn(() => Promise.resolve())

    const claimed = await claimNeverVerifiedAccount(user.id, inLock)

    expect(claimed.id).toBe(user.id)
    expect(claimed.emailVerifiedAt?.getTime()).toBe(user.emailVerifiedAt?.getTime())
    expect(inLock).not.toHaveBeenCalled()
    expect(await authProviderRepository.findByProviderAndId('google', googleId)).toBeDefined()
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${user.id} and purpose = 'refresh' and revoked_at is null
    `
    expect(row?.count).toBe(1)
    expect(verifiedUserIds).not.toContain(user.id)
  })

  it('claims a never-verified account: inLock runs, sessions end, email_verified once', async () => {
    const user = await createTrackedUser({ verified: false })
    await issueRefreshToken(user.id, randomUUID())
    const inLock = vi.fn(() => Promise.resolve())

    const claimed = await claimNeverVerifiedAccount(user.id, inLock)

    expect(claimed.emailVerifiedAt).toBeInstanceOf(Date)
    expect(inLock).toHaveBeenCalledOnce()
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${user.id} and purpose = 'refresh' and revoked_at is null
    `
    expect(row?.count).toBe(0)
    expect(verifiedUserIds.filter((id) => id === user.id)).toHaveLength(1)
  })

  it('audits the passkeys a claim deletes: one row with the count, none for a claim with no passkeys', async () => {
    const withPasskeys = await createTrackedUser({ verified: false })
    const without = await createTrackedUser({ verified: false })
    await sql`
      insert into user_passkeys (user_id, credential_id, public_key, aaguid, backup_eligible, backup_state, name)
      values
        (${withPasskeys.id}, ${randomUUID()}, '\\x00', ${randomUUID()}, false, false, 'One'),
        (${withPasskeys.id}, ${randomUUID()}, '\\x00', ${randomUUID()}, false, false, 'Two')
    `

    await claimNeverVerifiedAccount(withPasskeys.id)
    await claimNeverVerifiedAccount(without.id)

    const rows = await sql<{ metadata: unknown; actor_kind: string; access: string }[]>`
      select metadata, actor_kind, access from audit_logs
      where action = 'user.passkeys_cleared_on_claim' and target_id = ${withPasskeys.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata).toEqual({ count: 2 })
    expect(rows[0]?.actor_kind).toBe('system')
    const none = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_logs
      where action = 'user.passkeys_cleared_on_claim' and target_id = ${without.id}
    `
    expect(none[0]?.count).toBe(0)
    const left = await sql<{ count: number }[]>`
      select count(*)::int as count from user_passkeys where user_id = ${withPasskeys.id}
    `
    expect(left[0]?.count).toBe(0)
  })
})
