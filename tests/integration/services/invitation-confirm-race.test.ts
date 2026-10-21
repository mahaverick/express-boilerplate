/**
 * @file Races on the invitation confirm link. Two clicks of one link join
 * once; a confirm and an admin revoke, or a confirm and a deactivation,
 * never leave a session without its membership or a live session for a
 * deactivated account; two concurrent issues leave one live link; a
 * maintenance mode or an account change during the never-verified claim
 * writes no join. The confirm transaction locks the user row before it
 * claims the link, the order deactivate, staff sign-out and revoke-others
 * take; the mutation case shows the other order deadlocks against a
 * deactivation. Seams via `withMutatedMethod`, no sleeps.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { getEnv } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { deactivateUser } from '@/services/platform-user.service'
import { hashToken } from '@/services/session.service'
import { confirmInvitation, revoke } from '@/services/tenant-invitation.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userTokenRepository = new UserTokenRepository()

const HOUR_MS = 60 * 60 * 1000

/**
 * Every address this file used, for `afterEach` to delete accounts and links.
 */
const usedEmails: string[] = []

/**
 * Every tenant this file created, for `afterEach` to delete.
 */
const createdTenantIds: string[] = []

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `invite-confirm-race-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * A customer tenant owned by a fresh user (an owner member), tracked for cleanup.
 * @returns The tenant and its owner.
 */
async function createTenant(): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `invite-confirm-race-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * A pending invitation in `tenant` for `email`, and a live confirm link for it.
 * @param tenant - The tenant it invites to.
 * @param inviter - Who sent it.
 * @param email - The invited address.
 * @param linkApp - The frontend the link opens.
 * @returns The invitation's id and the link's raw token.
 */
async function invitationWithLink(
  tenant: Tenant,
  inviter: User,
  email: string,
  linkApp: FrontendApp = 'web'
): Promise<{ invitationId: string; raw: string }> {
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'editor',
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  const { raw } = await issueLinkToken(
    { intent: 'invitation', email, app: linkApp, invitationId: invitation.id },
    requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  )
  return { invitationId: invitation.id, raw }
}

/**
 * A customer invitation for `email` with a live confirm link.
 * @param email - The invited address.
 * @returns The tenant, its owner, the invitation's id and the link's raw token.
 */
async function invitedWithLink(
  email: string
): Promise<{ tenant: Tenant; owner: User; invitationId: string; raw: string }> {
  const { tenant, owner } = await createTenant()
  return { tenant, owner, ...(await invitationWithLink(tenant, owner, email)) }
}

/**
 * How many refresh rows a user holds, and how many are live.
 * @param userId - The user.
 * @returns The counts.
 */
async function refreshCounts(userId: string): Promise<{ all: number; live: number }> {
  const [row] = await sql<{ all: number; live: number }[]>`
    select count(*)::int as all, count(*) filter (where revoked_at is null)::int as live
    from user_tokens where user_id = ${userId} and purpose = 'refresh'
  `
  return { all: row?.all ?? 0, live: row?.live ?? 0 }
}

/**
 * Whether a link row is still unspent.
 * @param raw - The raw token.
 * @returns True while neither revoked nor consumed.
 */
async function isUnspent(raw: string): Promise<boolean> {
  const [row] = await sql<{ unspent: boolean }[]>`
    select revoked_at is null and consumed_at is null as unspent
    from user_tokens where token_hash = ${hashToken(raw)}
  `
  return row?.unspent === true
}

/**
 * Whether an invitation is still pending.
 * @param invitationId - The invitation.
 * @returns True while neither accepted nor revoked.
 */
async function isPending(invitationId: string): Promise<boolean> {
  const [row] = await sql<{ pending: boolean }[]>`
    select accepted_at is null and revoked_at is null as pending
    from tenant_invitations where id = ${invitationId}
  `
  return row?.pending === true
}

/**
 * The HTTP status a settled confirm or revoke came to: 200 when it succeeded.
 * @param result - The settled call.
 * @returns The status.
 */
function statusOf(result: PromiseSettledResult<unknown>): number {
  if (result.status === 'fulfilled') return 200
  return (result.reason as { statusCode?: number }).statusCode ?? 500
}

/**
 * The SQLSTATE a rejection carries, on itself or along its `cause` chain.
 * @param reason - What a call rejected with.
 * @returns The code, or undefined.
 */
function sqlStateOf(reason: unknown): string | undefined {
  let current: unknown = reason
  while (typeof current === 'object' && current !== null) {
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && /^[\dA-Z]{5}$/.test(code)) return code
    current = cause
  }
  return undefined
}

/**
 * Switch the maintenance mode for this replica, as a staff change would.
 * @param mode - The mode to switch to.
 */
async function switchMode(mode: 'read_only' | 'full'): Promise<void> {
  await storeMaintenanceMode(mode)
  await reloadMaintenanceMode()
}

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (usedEmails.length > 0) {
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * Run a confirm that holds its transaction open at the invitee's
 * user-row lock, start a deactivation of the invitee while it waits,
 * then let it go on.
 *
 * With `claimFirst`, the seam claims the link before taking the user
 * lock: the order the confirm must not use. The deactivation then holds
 * the user row and waits on the link row the confirm holds, while the
 * confirm waits on the user row.
 * @param options - Whether to claim the link before the user lock.
 * @param options.claimFirst - Claim the link first (the mutation).
 * @returns How the confirm and the deactivation settled, and the invitee.
 */
async function confirmBesideDeactivate(options: { claimFirst: boolean }): Promise<{
  confirmed: PromiseSettledResult<unknown>
  deactivated: PromiseSettledResult<unknown>
  inviteeId: string
}> {
  const { user: admin } = await createTrackedStaff('admin')
  const invitee = await createTrackedUser({ email: uniqueEmail('lock-order') })
  const { raw } = await invitedWithLink(invitee.email)
  const reached = deferred<number>()
  const release = deferred()
  // oxlint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
  const realLock = UserRepository.prototype.lockById
  /**
   * Stands in for `UserRepository.lockById` on the confirm's share lock of
   * the invitee: reports the confirm's backend and holds its transaction,
   * having taken the user lock first, or with `claimFirst` having claimed
   * the link first and taking the user lock only after the release.
   */
  const seamLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
    const [id, mode, tx] = arguments_
    if (mode !== 'share' || id !== invitee.id) return realLock.apply(this, arguments_)
    if (options.claimFirst) {
      await userTokenRepository.claimOnce(hashToken(raw), 'invitation_link', tx)
      reached.resolve(await backendPid(tx))
      await release.promise
      return realLock.apply(this, arguments_)
    }
    const locked = await realLock.apply(this, arguments_)
    reached.resolve(await backendPid(tx))
    await release.promise
    return locked
  }

  let outcome: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>] | undefined
  await withMutatedMethod(UserRepository.prototype, 'lockById', seamLock, async () => {
    const confirming = confirmInvitation(raw)
    const confirmPid = await untilSignalled(reached.promise, confirming, 'the confirm')
    const deactivating = deactivateUser({ userId: admin.id }, invitee.id, 'lock order test')
    expect(await waitForWaiter(confirmPid, deactivating)).toBe(true)
    release.resolve()
    outcome = await Promise.allSettled([confirming, deactivating])
  })
  if (!outcome) throw new Error('the race did not run')
  return { confirmed: outcome[0], deactivated: outcome[1], inviteeId: invitee.id }
}

/**
 * Stands in for `claimForAcceptById`: the invitation is gone by the time the
 * confirm claims it, after the link claim in the same transaction.
 * @returns Nothing claimed.
 */
async function deadInvitationClaim(): Promise<undefined> {
  await Promise.resolve()
}

/**
 * A confirm whose invitation dies after the link claim, in the same
 * transaction, answers `invitation_invalid` and leaves the link unspent; the
 * same link then joins.
 */
async function expectClaimRolledBack(): Promise<void> {
  const invitee = await createTrackedUser({ email: uniqueEmail('rollback') })
  const { tenant, invitationId, raw } = await invitedWithLink(invitee.email)
  let result: PromiseSettledResult<unknown> | undefined
  await withMutatedMethod(
    TenantInvitationRepository.prototype,
    'claimForAcceptById',
    deadInvitationClaim,
    async () => {
      ;[result] = await Promise.allSettled([confirmInvitation(raw)])
    }
  )

  expect(result).toMatchObject({ status: 'rejected', reason: { code: 'invitation_invalid' } })
  expect(await isUnspent(raw)).toBe(true)
  expect(await refreshCounts(invitee.id)).toEqual({ all: 0, live: 0 })
  expect(await isPending(invitationId)).toBe(true)

  await confirmInvitation(raw)
  expect(await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeDefined()
}

describe('invitation confirm races', () => {
  it('two concurrent confirms of one link give one session and one membership', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('twice') })
    const { tenant, raw } = await invitedWithLink(invitee.email)

    const results = await Promise.allSettled([confirmInvitation(raw), confirmInvitation(raw)])

    expect(results.map((result) => statusOf(result)).toSorted((a, b) => a - b)).toEqual([200, 404])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'invitation_invalid' },
    })
    expect(await refreshCounts(invitee.id)).toEqual({ all: 1, live: 1 })
    const [memberships] = await sql<{ count: number }[]>`
      select count(*)::int as count from user_memberships
      where tenant_id = ${tenant.id} and user_id = ${invitee.id}
    `
    expect(memberships?.count).toBe(1)
  })

  it('two concurrent confirms for a staff invitation to a new address create one user', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const email = uniqueEmail('staff-twice')
    const { raw } = await invitationWithLink(platform, inviter, email, 'apex')

    const results = await Promise.allSettled([confirmInvitation(raw), confirmInvitation(raw)])

    expect(results.map((result) => statusOf(result)).toSorted((a, b) => a - b)).toEqual([200, 404])
    const users = await sql<{ id: string }[]>`select id from users where lower(email) = ${email}`
    expect(users).toHaveLength(1)
    expect(await refreshCounts(users[0]?.id ?? '')).toEqual({ all: 1, live: 1 })
  })

  it('a confirm racing an admin revoke never leaves a session without a membership', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('revoke') })
    const { tenant, owner, invitationId, raw } = await invitedWithLink(invitee.email)

    const [confirmed, revoked] = await Promise.allSettled([
      confirmInvitation(raw),
      revoke({ userId: owner.id }, tenant.id, invitationId),
    ])

    const outcome = [statusOf(confirmed), statusOf(revoked)]
    expect([
      [200, 404],
      [404, 200],
    ]).toContainEqual(outcome)
    const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    const sessions = await refreshCounts(invitee.id)
    if (outcome[0] === 200) {
      expect(membership).toBeDefined()
      expect(sessions.live).toBe(1)
    } else {
      expect(membership).toBeUndefined()
      expect(sessions.all).toBe(0)
      // A refused confirm spends nothing, so the link outlives the revoked invitation unused.
      expect(await isUnspent(raw)).toBe(true)
    }
  })

  it('a deactivation committed mid-confirm wins and leaves no live session', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('deactivated-mid') })
    const { tenant, raw } = await invitedWithLink(invitee.email)
    // oxlint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realLock = UserRepository.prototype.lockById
    /**
     * Stands in for `UserRepository.lockById`: just before the confirm locks
     * the invitee's row, a deactivation commits on another connection.
     */
    const deactivatingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
      const [id, mode] = arguments_
      if (mode === 'share' && id === invitee.id) {
        await sql`update users set active = false where id = ${invitee.id}`
      }
      return realLock.apply(this, arguments_)
    }

    let result: PromiseSettledResult<unknown> | undefined
    await withMutatedMethod(UserRepository.prototype, 'lockById', deactivatingLock, async () => {
      ;[result] = await Promise.allSettled([confirmInvitation(raw)])
    })

    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'invitation_invalid' } })
    expect(await refreshCounts(invitee.id)).toEqual({ all: 0, live: 0 })
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    expect(await isUnspent(raw)).toBe(true)
  })

  it('rolls the link claim back when the invitation dies after the claim', async () => {
    await expectClaimRolledBack()
  })

  /**
   * Deliberately red under MUTATION_PROOF=1: the link's claim runs on the
   * pool, outside the joining transaction (the `db`-for-`tx` mistake), so
   * the refusal after it leaves the link spent.
   *
   *   MUTATION_PROOF=1 pnpm test tests/integration/services/invitation-confirm-race.test.ts   # red
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces a spent link when the claim runs outside the transaction',
    async () => {
      // oxlint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realClaim = UserTokenRepository.prototype.claimOnce
      /**
       * Stands in for `claimOnce`: the same claim, always on the pool.
       */
      const poolClaim: typeof realClaim = function (this: UserTokenRepository, ...arguments_) {
        const [tokenHash, purpose, , bound] = arguments_
        return realClaim.call(this, tokenHash, purpose, db, bound)
      }
      await withMutatedMethod(UserTokenRepository.prototype, 'claimOnce', poolClaim, async () => {
        await expectClaimRolledBack()
      })
    }
  )

  it('two concurrent issues for one address and invitation leave one live invitation link', async () => {
    const email = uniqueEmail('issue-twice')
    const { tenant, owner } = await createTenant()
    const { invitationId } = await invitationWithLink(tenant, owner, email)
    await sql`delete from user_tokens where email = ${email}`

    await Promise.all(
      Array.from({ length: 5 }, () =>
        issueLinkToken({ intent: 'invitation', email, app: 'web', invitationId }, HOUR_MS)
      )
    )

    const [row] = await sql<{ live: number }[]>`
      select count(*)::int as live from user_tokens
      where email = ${email} and purpose = 'invitation_link' and revoked_at is null
    `
    expect(row?.live).toBe(1)
  })

  it.each([
    ['read_only', READ_ONLY_MODE_CODE],
    ['full', MAINTENANCE_MODE_CODE],
  ] as const)(
    'writes no join when %s begins during the never-verified claim',
    async (mode, code) => {
      const invitee = await createTrackedUser({ email: uniqueEmail(mode), verified: false })
      if (mode === 'full') await makeStaff(invitee.id, 'viewer')
      const { tenant, invitationId, raw } = await invitedWithLink(invitee.email)
      // oxlint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realLock = UserRepository.prototype.lockById
      /**
       * Stands in for `UserRepository.lockById`: the claim's first lock switches the mode.
       */
      const switchingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
        const [id, lockMode] = arguments_
        if (lockMode === 'no key update' && id === invitee.id) await switchMode(mode)
        return realLock.apply(this, arguments_)
      }

      let result: PromiseSettledResult<unknown> | undefined
      await withMutatedMethod(UserRepository.prototype, 'lockById', switchingLock, async () => {
        ;[result] = await Promise.allSettled([confirmInvitation(raw)])
      })

      expect(result).toMatchObject({ status: 'rejected', reason: { statusCode: 503, code } })
      const sessions = await refreshCounts(invitee.id)
      expect(sessions.live).toBe(0)
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
      expect(await isUnspent(raw)).toBe(true)
      expect(await isPending(invitationId)).toBe(true)
    }
  )

  it.each(['deleted', 'deactivated'] as const)(
    'answers invitation_invalid when the never-verified invitee is %s during the claim',
    async (change) => {
      const invitee = await createTrackedUser({ email: uniqueEmail(change), verified: false })
      const { tenant, raw } = await invitedWithLink(invitee.email)
      // oxlint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realLock = UserRepository.prototype.lockById
      const changed = { done: false }
      /**
       * Stands in for `UserRepository.lockById`: just before the claim's first
       * lock, a delete or a deactivation commits on another connection.
       */
      const changingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
        const [id, lockMode] = arguments_
        if (lockMode === 'no key update' && id === invitee.id && !changed.done) {
          changed.done = true
          await (change === 'deleted'
            ? sql`update users set deleted_at = now() where id = ${invitee.id}`
            : sql`update users set active = false where id = ${invitee.id}`)
        }
        return realLock.apply(this, arguments_)
      }

      let result: PromiseSettledResult<unknown> | undefined
      await withMutatedMethod(UserRepository.prototype, 'lockById', changingLock, async () => {
        ;[result] = await Promise.allSettled([confirmInvitation(raw)])
      })

      expect(result).toMatchObject({ status: 'rejected', reason: { code: 'invitation_invalid' } })
      const sessions = await refreshCounts(invitee.id)
      expect(sessions.all).toBe(0)
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
      expect(await isUnspent(raw)).toBe(true)
    }
  )

  describe('lock order: the user row before the link row', () => {
    it('queues a deactivation behind the confirm, which then revokes its session', async () => {
      const { confirmed, deactivated, inviteeId } = await confirmBesideDeactivate({
        claimFirst: false,
      })

      expect(confirmed.status).toBe('fulfilled')
      expect(deactivated.status).toBe('fulfilled')
      expect(await refreshCounts(inviteeId)).toEqual({ all: 1, live: 0 })
    })

    it('deadlocks with 40P01 when the link is claimed before the user lock', async () => {
      const { confirmed, deactivated } = await confirmBesideDeactivate({ claimFirst: true })

      const states = [confirmed, deactivated].map((result) =>
        result.status === 'rejected' ? sqlStateOf(result.reason) : 'fulfilled'
      )
      expect(states).toContain('40P01')
    })
  })
})
