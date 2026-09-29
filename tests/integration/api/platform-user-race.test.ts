/**
 * @file Concurrency and the platform last-owner guard: two platform owners
 * deleting each other (the second queues behind the first's locks, then
 * finds its own account gone and gets 401; no deadlock), an actor whose
 * account went inactive before the locks, and the last-active-platform-owner
 * guard as a pure function, since the route rules keep it unreachable.
 * Seams via withMutatedMethod, no sleeps.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { sql, type DbTransaction } from '@/services/database.service'
import {
  assertPlatformOwnerRemains,
  deactivateUser,
  deleteUser,
  signOutUser,
} from '@/services/platform-user.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const REASON = 'race test'
const DEADLOCK_TIMEOUT_MS = 10_000

afterEach(async () => {
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

describe('concurrent staff deletes', () => {
  it(
    'two platform owners deleting each other: the second waits on the first, then gets 401',
    async () => {
      const a = await createTrackedStaff('owner')
      const b = await createTrackedStaff('owner')
      // A third active owner, so the guard never decides the race: only the locks do.
      await createTrackedStaff('owner')

      // Pause the first delete inside its transaction, after the soft delete and before commit.
      const reached = deferred<number>()
      const release = deferred()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realRevoke = TenantInvitationRepository.prototype.revokePendingByInviter
      let calls = 0
      const pausingRevoke: typeof realRevoke = async function (
        this: TenantInvitationRepository,
        ...arguments_
      ) {
        calls += 1
        const revoked = await realRevoke.apply(this, arguments_)
        if (calls === 1) {
          reached.resolve(await backendPid(arguments_[1] as DbTransaction))
          await release.promise
        }
        return revoked
      }

      let outcomes: PromiseSettledResult<unknown>[] = []
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'revokePendingByInviter',
        pausingRevoke,
        async () => {
          const aDeletesB = deleteUser({ userId: a.user.id }, b.user.id, REASON)
          const firstPid = await untilSignalled(reached.promise, aDeletesB, 'first delete')
          const bDeletesA = deleteUser({ userId: b.user.id }, a.user.id, REASON)
          // The second delete queues behind the first's platform owner locks.
          expect(await waitForWaiter(firstPid, bDeletesA)).toBe(true)
          release.resolve()
          outcomes = await Promise.allSettled([aDeletesB, bDeletesA])
        }
      )

      expect(outcomes[0]?.status).toBe('fulfilled')
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 401, message: 'Account no longer exists or is inactive' },
      })
      const deleted = await sql<{ id: string }[]>`
        select id from users where id = any(${[a.user.id, b.user.id]}) and deleted_at is not null`
      expect(deleted.map((row) => row.id)).toEqual([b.user.id])
    },
    DEADLOCK_TIMEOUT_MS
  )
})

describe('an actor whose account went inactive after the route gates', () => {
  it.each([
    ['deactivate', deactivateUser],
    ['sign out', signOutUser],
    ['delete', deleteUser],
  ] as const)('%s: 401 and nothing written', async (_verb, run) => {
    const { user: admin } = await createTrackedStaff('admin')
    const target = await createTrackedUser()
    await sql`update users set active = false where id = ${admin.id}`

    await expect(run({ userId: admin.id }, target.id, REASON)).rejects.toMatchObject({
      statusCode: 401,
      message: 'Account no longer exists or is inactive',
    })
    const [row] = await sql<{ active: boolean; deleted: boolean }[]>`
      select active, deleted_at is not null as deleted from users where id = ${target.id}`
    expect(row).toEqual({ active: true, deleted: false })
    const audit = await sql`select 1 from audit_logs where target_id = ${target.id}`
    expect(audit).toHaveLength(0)
  })
})

describe('assertPlatformOwnerRemains', () => {
  it('refuses when the target is the last active platform owner, and allows a spare owner or a non-owner', () => {
    // The second argument counts the OTHER active platform owners.
    expect(() => assertPlatformOwnerRemains('owner', 0, 'deactivate')).toThrow(
      'Cannot deactivate the last platform owner'
    )
    expect(() => assertPlatformOwnerRemains('owner', 0, 'delete')).toThrow(
      'Cannot delete the last platform owner'
    )
    expect(() => assertPlatformOwnerRemains('owner', 1, 'delete')).not.toThrow()
    expect(() => assertPlatformOwnerRemains('admin', 0, 'delete')).not.toThrow()
    // eslint-disable-next-line unicorn/no-null -- a non-staff target
    expect(() => assertPlatformOwnerRemains(null, 0, 'delete')).not.toThrow()
  })
})
