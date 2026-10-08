/**
 * @file The analytics outbox writes against the real per-worker Postgres:
 * every audit entry forwards inside its own transaction, a rollback discards
 * both, and an outbox insert Postgres itself refuses never fails the audited
 * change, inside `record` (a savepoint) or via `recordPlatformAccess` (the
 * pool). The savepoint is shown to be load-bearing by removing it in memory
 * and watching the same failure abort the caller's transaction. Analytics is
 * off under `.env.test`, so `isAnalyticsEnabled` is mocked here.
 */
import { randomUUID } from 'node:crypto'
import { context, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { PostgresJsTransaction } from 'drizzle-orm/postgres-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewAnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { enqueueAnalytics } from '@/services/analytics/analytics-outbox.service'
import { record, recordPlatformAccess, type AuditEntry } from '@/services/audit.service'
import { db, sql, withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requestContextStore } from '@/services/request-context.service'
import {
  clearOutbox,
  outboxRows,
  outboxRowsOf,
  overlongInsertMany,
} from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'

const analytics = vi.hoisted(() => ({ isEnabled: true }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => analytics.isEnabled }
})

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const createdTenantIds: string[] = []
const createdRedisKeys: string[] = []
const SESSION_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const SPAN_CONTEXT = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: TraceFlags.SAMPLED,
}

beforeAll(() => {
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(true)
})

afterAll(() => {
  context.disable()
})

beforeEach(async () => {
  analytics.isEnabled = true
  await clearOutbox()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearOutbox()
  if (createdRedisKeys.length > 0) {
    const redis = await getRedis()
    await redis.del(createdRedisKeys)
    createdRedisKeys.length = 0
  }
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  await deleteTrackedUsers()
})

/**
 * A user and a tenant they own, tracked for cleanup.
 * @returns Their ids.
 */
async function ownerAndTenant(): Promise<{ userId: string; tenantId: string }> {
  const user = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Outbox Co',
    slug: `outbox-${randomUUID()}`,
    ownerId: user.id,
  })
  createdTenantIds.push(tenant.id)
  return { userId: user.id, tenantId: tenant.id }
}

/**
 * A valid `tenant.updated` entry.
 * @param userId - The actor.
 * @param tenantId - The tenant.
 * @returns The entry.
 */
function tenantUpdated(userId: string, tenantId: string): AuditEntry {
  return {
    action: 'tenant.updated',
    actor: { userId },
    access: 'member',
    tenantId,
    targetId: tenantId,
    metadata: { changed: ['name'] },
  }
}

/**
 * Rename a tenant in `tx`, as the audited business change.
 * @param tenantId - The tenant.
 * @param name - The new name.
 * @param tx - The transaction.
 */
async function rename(
  tenantId: string,
  name: string,
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0]
): Promise<void> {
  await tenantRepository.update(tenantId, { name }, {}, tx)
}

/**
 * The tenant's committed name.
 * @param tenantId - The tenant.
 * @returns Its name.
 */
async function committedName(tenantId: string): Promise<string | undefined> {
  const tenant = await tenantRepository.findById(tenantId)
  return tenant?.name
}

/**
 * The tenant's committed audit rows.
 * @param tenantId - The tenant.
 * @returns The rows' actions.
 */
async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await sql<{ action: string }[]>`
    select action from audit_logs where tenant_id = ${tenantId} order by occurred_at, id`
  return rows.map((row) => row.action)
}

describe('record forwards an audit entry to the outbox', () => {
  it('writes nothing while analytics is disabled', async () => {
    analytics.isEnabled = false
    const { userId, tenantId } = await ownerAndTenant()

    await withTransaction((tx) => record(tenantUpdated(userId, tenantId), tx))

    expect(await auditActions(tenantId)).toEqual(['tenant.updated'])
    expect(await outboxRows()).toEqual([])
  })

  it('writes the event, and its group row, in the audited transaction', async () => {
    const { userId, tenantId } = await ownerAndTenant()

    await withTransaction(async (tx) => {
      await rename(tenantId, 'Renamed Co', tx)
      await record(tenantUpdated(userId, tenantId), tx)
    })

    const rows = await outboxRows()
    expect(rows.map((row) => row.event)).toEqual(['tenant_updated', '$groupidentify'])
    expect(rows[0]).toMatchObject({
      distinctId: userId,
      properties: {
        source: 'audit',
        access: 'member',
        app: 'api',
        target_type: 'tenant',
        target_id: tenantId,
        changed: ['name'],
        $groups: { tenant: tenantId },
      },
    })
    // A marker only: the drainer reads the tenant's state, the rename included, when it sends it.
    expect(rows[1]).toMatchObject({
      distinctId: `$tenant_${tenantId}`,
      properties: { source: 'audit', $group_type: 'tenant', $group_key: tenantId },
    })
    expect(rows[1]?.properties).not.toHaveProperty('$group_set')
    expect(JSON.stringify(rows[1])).not.toContain('Renamed Co')
  })

  it('loses the outbox rows with the audit row when the transaction rolls back', async () => {
    const { userId, tenantId } = await ownerAndTenant()

    await expect(
      withTransaction(async (tx) => {
        await record(tenantUpdated(userId, tenantId), tx)
        throw new Error('roll back')
      })
    ).rejects.toThrow('roll back')

    expect(await auditActions(tenantId)).toEqual([])
    expect(await outboxRows()).toEqual([])
  })

  it('carries the request trace and browser session onto the row', async () => {
    const { userId, tenantId } = await ownerAndTenant()
    const span = trace.wrapSpanContext(SPAN_CONTEXT)

    await requestContextStore.run(
      { requestId: 'req-outbox-1', posthogSessionId: SESSION_ID, userId },
      () =>
        context.with(trace.setSpan(context.active(), span), () =>
          withTransaction((tx) => record(tenantUpdated(userId, tenantId), tx))
        )
    )

    const [row] = await outboxRowsOf('tenant_updated')
    expect(row?.properties).toMatchObject({
      trace_id: SPAN_CONTEXT.traceId,
      span_id: SPAN_CONTEXT.spanId,
      $session_id: SESSION_ID,
    })
  })
})

describe('an outbox insert Postgres refuses', () => {
  it('inside record, rolls back only its savepoint: the audit row and the change commit', async () => {
    const { userId, tenantId } = await ownerAndTenant()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'insertMany',
      overlongInsertMany,
      () =>
        withTransaction(async (tx) => {
          await record(tenantUpdated(userId, tenantId), tx)
          // A write after the failed savepoint: it fails too if the transaction was aborted.
          await rename(tenantId, 'Still Renamed Co', tx)
        })
    )

    expect(await committedName(tenantId)).toBe('Still Renamed Co')
    expect(await auditActions(tenantId)).toEqual(['tenant.updated'])
    expect(await outboxRows()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      'Analytics outbox write failed',
      expect.objectContaining({ events: ['tenant_updated'], analyticsOutboxWriteFailed: 1 })
    )
  })

  it('would abort the whole transaction without the savepoint, so the savepoint is load-bearing', async () => {
    const { userId, tenantId } = await ownerAndTenant()
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const runWithoutSavepoint = function (
      this: PostgresJsTransaction<Record<string, never>, Record<string, never>>,
      work: (
        tx: PostgresJsTransaction<Record<string, never>, Record<string, never>>
      ) => Promise<unknown>
    ) {
      return work(this)
    } as PostgresJsTransaction<Record<string, never>, Record<string, never>>['transaction']

    await withMutatedMethod(
      PostgresJsTransaction.prototype,
      'transaction',
      runWithoutSavepoint,
      () =>
        withMutatedMethod(
          AnalyticsOutboxRepository.prototype,
          'insertMany',
          overlongInsertMany,
          async () => {
            await expect(
              withTransaction(async (tx) => {
                await record(tenantUpdated(userId, tenantId), tx)
                await rename(tenantId, 'Never Renamed Co', tx)
              })
            ).rejects.toMatchObject({ cause: { code: '25P02' } })
          }
        )
    )

    expect(await committedName(tenantId)).toBe('Outbox Co')
    expect(await auditActions(tenantId)).toEqual([])
  })

  it('via recordPlatformAccess, is logged and the audit row is still written', async () => {
    const { tenantId } = await ownerAndTenant()
    const { user: staff } = await createTrackedStaff('viewer')
    createdRedisKeys.push(redisKey('audit', 'platform-access', staff.id, tenantId))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    let written: Awaited<ReturnType<typeof recordPlatformAccess>>
    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'insertMany',
      overlongInsertMany,
      async () => {
        written = await recordPlatformAccess({ userId: staff.id }, tenantId, 'viewer')
      }
    )

    expect(written).toMatchObject({ action: 'tenant.accessed_by_platform' })
    expect(await auditActions(tenantId)).toEqual(['tenant.accessed_by_platform'])
    expect(await outboxRows()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      'Analytics outbox write failed',
      expect.objectContaining({ events: ['tenant_accessed_by_platform'] })
    )
  })
})

describe('recordPlatformAccess forwards on the pool', () => {
  it('writes a platform-access event as the staff user', async () => {
    const { tenantId } = await ownerAndTenant()
    const { user: staff } = await createTrackedStaff('admin')
    createdRedisKeys.push(redisKey('audit', 'platform-access', staff.id, tenantId))

    await recordPlatformAccess({ userId: staff.id }, tenantId, 'admin')

    expect(await outboxRows()).toEqual([
      expect.objectContaining({
        event: 'tenant_accessed_by_platform',
        distinctId: staff.id,
        properties: expect.objectContaining({
          access: 'platform',
          platform_role: 'admin',
          $groups: { tenant: tenantId },
        }) as unknown,
      }),
    ])
  })
})

describe('staff status rows', () => {
  it("sets the affected user's new platform role after a role change in the platform tenant", async () => {
    const platform = await platformTenant()
    const { user: actor } = await createTrackedStaff('owner')
    const { user: target } = await createTrackedStaff('viewer')
    const membership = await userMembershipRepository.findByUserAndTenant(target.id, platform.id)
    const membershipId = membership?.id ?? ''

    await withTransaction(async (tx) => {
      await userMembershipRepository.updateRole(membershipId, 'admin', tx)
      await record(
        {
          action: 'member.role_changed',
          actor: { userId: actor.id },
          access: 'member',
          tenantId: platform.id,
          targetId: membershipId,
          metadata: { userId: target.id, from: 'viewer', to: 'admin' },
        },
        tx
      )
    })

    const rows = await outboxRowsOf('$set')
    expect(rows).toEqual([
      expect.objectContaining({
        distinctId: target.id,
        properties: expect.objectContaining({
          $set: { is_staff: true, platform_role: 'admin' },
        }) as unknown,
      }),
    ])
  })

  it('adds no $set row for a role change in a customer tenant', async () => {
    const { userId, tenantId } = await ownerAndTenant()
    const member = await createTrackedUser()
    const membership = await userMembershipRepository.create({
      userId: member.id,
      tenantId,
      role: 'viewer',
    })

    await withTransaction(async (tx) => {
      await userMembershipRepository.updateRole(membership.id, 'editor', tx)
      await record(
        {
          action: 'member.role_changed',
          actor: { userId },
          access: 'member',
          tenantId,
          targetId: membership.id,
          metadata: { userId: member.id, from: 'viewer', to: 'editor' },
        },
        tx
      )
    })

    const rows = await outboxRows()
    expect(rows.map((row) => row.event)).toEqual(['member_role_changed'])
  })

  it('sets the accepting user as staff when they accept an invitation to the platform tenant', async () => {
    const platform = await platformTenant()
    const invitee = await createTrackedUser()

    await withTransaction(async (tx) => {
      const membership = await userMembershipRepository.create(
        { userId: invitee.id, tenantId: platform.id, role: 'viewer' },
        tx
      )
      await record(
        {
          action: 'invitation.accepted',
          actor: { userId: invitee.id },
          access: 'member',
          tenantId: platform.id,
          targetId: membership.id,
          metadata: { role: 'viewer', invitationId: randomUUID() },
        },
        tx
      )
    })

    const rows = await outboxRows()
    expect(rows.map((row) => row.event)).toEqual(['invitation_accepted', '$set'])
    expect(rows[1]).toMatchObject({
      distinctId: invitee.id,
      properties: { $set: { is_staff: true, platform_role: 'viewer' } },
    })
  })

  it("clears the leaver's staff status when they leave the platform tenant", async () => {
    const platform = await platformTenant()
    const { user: leaver } = await createTrackedStaff('viewer')
    const membership = await userMembershipRepository.findByUserAndTenant(leaver.id, platform.id)
    const membershipId = membership?.id ?? ''

    await withTransaction(async (tx) => {
      await userMembershipRepository.delete(membershipId, tx)
      await record(
        {
          action: 'member.left',
          actor: { userId: leaver.id },
          access: 'member',
          tenantId: platform.id,
          targetId: membershipId,
          metadata: { role: 'viewer' },
        },
        tx
      )
    })

    const rows = await outboxRows()
    expect(rows.map((row) => row.event)).toEqual(['member_left', '$set'])
    expect(rows[1]).toMatchObject({
      distinctId: leaver.id,
      // eslint-disable-next-line unicorn/no-null -- the $set row records JSON null for "not staff"
      properties: { $set: { is_staff: false, platform_role: null } },
    })
  })

  it('adds no $set row for an invitation accepted into a customer tenant', async () => {
    const { tenantId } = await ownerAndTenant()
    const invitee = await createTrackedUser()

    await withTransaction(async (tx) => {
      const membership = await userMembershipRepository.create(
        { userId: invitee.id, tenantId, role: 'viewer' },
        tx
      )
      await record(
        {
          action: 'invitation.accepted',
          actor: { userId: invitee.id },
          access: 'member',
          tenantId,
          targetId: membership.id,
          metadata: { role: 'viewer', invitationId: randomUUID() },
        },
        tx
      )
    })

    const rows = await outboxRows()
    expect(rows.map((row) => row.event)).toEqual(['invitation_accepted'])
  })
})

describe('enqueueAnalytics', () => {
  const probe: NewAnalyticsOutboxRow = {
    event: 'probe_event',
    distinctId: 'system',
    properties: { source: 'product' },
  }

  it('inserts on the pool, and does nothing for no rows or while disabled', async () => {
    await enqueueAnalytics([], db)
    analytics.isEnabled = false
    await enqueueAnalytics([probe], db)
    expect(await outboxRows()).toEqual([])

    analytics.isEnabled = true
    await enqueueAnalytics([probe], db)
    expect(await outboxRowsOf('probe_event')).toHaveLength(1)
  })

  it('swallows a refused pool insert, logging the event names', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await withMutatedMethod(
      AnalyticsOutboxRepository.prototype,
      'insertMany',
      overlongInsertMany,
      async () => {
        await expect(enqueueAnalytics([probe], db)).resolves.toBeUndefined()
      }
    )

    expect(warn).toHaveBeenCalledWith(
      'Analytics outbox write failed',
      expect.objectContaining({ events: ['probe_event'], analyticsOutboxWriteFailed: 1 })
    )
  })
})
