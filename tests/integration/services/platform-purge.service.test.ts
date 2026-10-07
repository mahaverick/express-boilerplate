/**
 * @file A user purge against a concurrent platform role change, under a
 * forced interleaving. A third connection holds an `audit_logs` row the purge
 * updates, so the purge pauses mid-transaction; the role change then locks
 * the platform owners in id order (the soft-deleted owner first); releasing
 * the third connection lets the purge reach the delete of that owner's
 * membership. Both must finish: the purge takes the owner lock order first.
 */
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { record } from '@/services/audit.service'
import { sql, withTransaction } from '@/services/database.service'
import { purgeUser } from '@/services/platform-purge.service'
import { changeRole } from '@/services/tenant-membership.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { pollUntil, waitForWaiter } from '../../helpers/lock-probe'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'

// The test pool holds DB_POOL_MAX=2, which the purge and the role change take: the blocker gets its own.
const blockerClient = postgres(getEnv().DATABASE_URL, { max: 1 })

afterAll(async () => {
  await blockerClient.end()
  await truncateAuditLogs()
  await sql`delete from analytics_deletions`
  await deleteTrackedUsers()
})

/**
 * How a service call ended: 'ok', or the Postgres code and message it was rejected with.
 * @param work - The call.
 * @returns The outcome.
 */
async function outcomeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
    return 'ok'
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    return `rejected: ${cause?.code ?? ''} ${cause?.message ?? ''}`
  }
}

describe('S7-25: cascade-delete lock order', () => {
  it('a purge and a concurrent platform role change both complete (no deadlock 500)', async () => {
    const platform = await platformTenant()
    // Creation order fixes the uuidv7 order: U < A < C < V.
    const { user: u } = await createTrackedStaff('owner')
    const { user: a } = await createTrackedStaff('owner')
    const { user: c } = await createTrackedStaff('owner')
    const { user: v } = await createTrackedStaff('viewer')
    await sql`update users set deleted_at = now(), active = false where id = ${u.id}`
    // An audit row acted by U, which the purge's redaction updates.
    await withTransaction((tx) =>
      record(
        {
          action: 'user.deleted',
          actor: { userId: u.id },
          access: 'platform',
          tenantId: platform.id,
          targetId: v.id,
          metadata: { reason: 'setup' },
        },
        tx
      )
    )

    const blocker = await blockerClient.reserve()
    let isBlockerOpen = false
    const started: Promise<string>[] = []
    try {
      await blocker`begin`
      isBlockerOpen = true
      await blocker`select id from audit_logs where actor_user_id = ${u.id} for update`
      const [holder] = await blocker<{ pid: number }[]>`select pg_backend_pid() as pid`
      const purge = outcomeOf(purgeUser({ userId: a.id }, u.id, 'S7-25 probe'))
      started.push(purge)
      expect(await waitForWaiter(holder?.pid ?? 0, purge)).toBe(true)

      const roleChange = outcomeOf(
        changeRole({ userId: c.id }, platform.id, v.id, 'editor', { isPlatformTenant: true })
      )
      started.push(roleChange)
      const isWaiting = await pollUntil(
        async (probe) => {
          const [row] = await probe<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query ilike '%user_memberships%'`
          return (row?.n ?? 0) > 0
        },
        roleChange,
        5000,
        'the role change waiting on a membership lock'
      )
      expect(isWaiting).toBe(true)
      await blocker`commit`
      isBlockerOpen = false

      expect(await Promise.all([purge, roleChange])).toEqual(['ok', 'ok'])
    } finally {
      // Only on an early failure: it releases the row the purge is queued behind.
      if (isBlockerOpen) await blocker`rollback`
      blocker.release()
      // An early failure leaves these running; let them finish before afterAll cleans up.
      await Promise.allSettled(started)
    }
  })
})
