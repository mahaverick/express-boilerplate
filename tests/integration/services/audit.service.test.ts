// tests/integration/services/audit.service.test.ts
//
// The audit service against the real per-worker Postgres and the shared
// Redis. Redis faults are injected by swapping one method on the shared
// client (tests/helpers/mutate.ts), never by touching the server. Dedupe keys
// are deleted in afterEach, since global setup clears only rate-limit keys.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record, recordPlatformAccess, type AuditEntry } from '@/services/audit.service'
import { sql, withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requestContextStore } from '@/services/request-context.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []
const createdRedisKeys: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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
  if (createdUserIds.length === 0) return
  await sql`delete from users where id = any(${createdUserIds})`
  createdUserIds.length = 0
})

/**
 * A user and a tenant they own, both tracked for cleanup.
 * @returns Their ids.
 */
async function createOwnerAndTenant(): Promise<{ userId: string; tenantId: string }> {
  const user = await userRepository.create({ email: `audit-service-${randomUUID()}@example.test` })
  createdUserIds.push(user.id)
  const tenant = await tenantRepository.create({
    name: 'Audit Co',
    slug: `audit-${randomUUID()}`,
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
 * The audit rows for one tenant.
 * @param tenantId - The tenant.
 * @returns Its rows, oldest first.
 */
async function auditRows(tenantId: string) {
  return sql`select * from audit_logs where tenant_id = ${tenantId} order by occurred_at, id`
}

/**
 * The dedupe key for one staff user and tenant, tracked for cleanup.
 * @param userId - The staff user.
 * @param tenantId - The tenant.
 * @returns The key.
 */
function trackedDedupeKey(userId: string, tenantId: string): string {
  const key = redisKey('audit', 'platform-access', userId, tenantId)
  createdRedisKeys.push(key)
  return key
}

/**
 * An `AuditLogRepository.insert` stand-in that always fails.
 * @returns Never; always rejects.
 */
function refuseInsert(): Promise<never> {
  return Promise.reject(new Error('insert failed'))
}

describe('record', () => {
  it('writes one row with the target type its action defines and the request metadata', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const longAgent = 'A'.repeat(600)

    await requestContextStore.run(
      { requestId: 'req-audit-1', ip: '203.0.113.9', userAgent: longAgent },
      () => withTransaction((tx) => record(tenantUpdated(userId, tenantId), tx))
    )

    const rows = await auditRows(tenantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_kind: 'user',
      actor_user_id: userId,
      access: 'member',
      action: 'tenant.updated',
      target_type: 'tenant',
      target_id: tenantId,
      metadata: { changed: ['name'] },
      request_id: 'req-audit-1',
      ip: '203.0.113.9',
    })
    expect(rows[0]?.user_agent).toBe('A'.repeat(512))
  })

  it('truncates a long request id to 64 characters', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const longRequestId = 'r'.repeat(100)

    await requestContextStore.run({ requestId: longRequestId }, () =>
      withTransaction((tx) => record(tenantUpdated(userId, tenantId), tx))
    )

    const [row] = await auditRows(tenantId)
    expect(row?.request_id).toBe('r'.repeat(64))
  })

  it('truncates a long ip to 45 characters', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const longIp = '1'.repeat(100)

    await requestContextStore.run({ requestId: 'req-audit-ip', ip: longIp }, () =>
      withTransaction((tx) => record(tenantUpdated(userId, tenantId), tx))
    )

    const [row] = await auditRows(tenantId)
    expect(row?.ip).toBe('1'.repeat(45))
  })

  it('writes a system entry with no actor and no request metadata outside a request', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()

    await withTransaction((tx) =>
      record(
        {
          action: 'platform.member.granted',
          actor: 'system',
          access: 'system',
          tenantId,
          targetId: randomUUID(),
          metadata: { userId, role: 'admin', via: 'script' },
        },
        tx
      )
    )

    const [row] = await auditRows(tenantId)
    expect(row).toMatchObject({ actor_kind: 'system', target_type: 'membership' })
    expect(row?.actor_user_id).toBeNull()
    expect(row?.request_id).toBeNull()
    expect(row?.ip).toBeNull()
    expect(row?.user_agent).toBeNull()
  })

  it('rolls back with the caller’s transaction', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()

    await expect(
      withTransaction(async (tx) => {
        await record(tenantUpdated(userId, tenantId), tx)
        throw new Error('the audited change failed')
      })
    ).rejects.toThrow('the audited change failed')

    expect(await auditRows(tenantId)).toHaveLength(0)
  })

  it.each([
    ['an unknown key', { changed: ['name'], email: 'ada@example.test' }],
    ['a wrong type', { changed: 'name' }],
    ['a missing key', {}],
  ])('throws on metadata with %s and writes nothing', async (_label, metadata) => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const entry = { ...tenantUpdated(userId, tenantId), metadata } as unknown as AuditEntry

    await expect(withTransaction((tx) => record(entry, tx))).rejects.toThrow(
      'Invalid audit metadata for tenant.updated'
    )
    expect(await auditRows(tenantId)).toHaveLength(0)
  })

  it('keeps rejected values out of the error message', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const entry = {
      ...tenantUpdated(userId, tenantId),
      action: 'invitation.created',
      metadata: { role: 'viewer', emailDomain: 'ada@example.test' },
    } as unknown as AuditEntry

    let message = ''
    try {
      await withTransaction((tx) => record(entry, tx))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Invalid audit metadata for invitation.created')
    expect(message).toContain('emailDomain')
    expect(message).not.toContain('ada@example.test')
  })
})

describe('recordPlatformAccess', () => {
  it('writes one entry per staff user and tenant within the hour', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    trackedDedupeKey(userId, tenantId)

    const first = await recordPlatformAccess({ userId }, tenantId, 'viewer')
    const second = await recordPlatformAccess({ userId }, tenantId, 'viewer')

    expect(first).toMatchObject({
      action: 'tenant.accessed_by_platform',
      access: 'platform',
      actorUserId: userId,
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { platformRole: 'viewer' },
    })
    expect(second).toBeUndefined()
    expect(await auditRows(tenantId)).toHaveLength(1)
  })

  it('sets the dedupe key with a one-hour expiry', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const key = trackedDedupeKey(userId, tenantId)

    await recordPlatformAccess({ userId }, tenantId, 'admin')

    const redis = await getRedis()
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(3500)
    expect(ttl).toBeLessThanOrEqual(3600)
  })

  it('still writes, every time, when Redis errors, and logs a warning', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    trackedDedupeKey(userId, tenantId)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const redis = await getRedis()
    const failingSet = (() => Promise.reject(new Error('redis unavailable'))) as typeof redis.set

    await withMutatedMethod(redis, 'set', failingSet, async () => {
      await recordPlatformAccess({ userId }, tenantId, 'viewer')
      await recordPlatformAccess({ userId }, tenantId, 'viewer')
    })

    expect(await auditRows(tenantId)).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      'Platform access dedupe unavailable; writing the audit entry anyway',
      { error: 'redis unavailable' }
    )
  })

  it('releases the dedupe key when the insert fails, so the next visit is recorded', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const key = trackedDedupeKey(userId, tenantId)
    await withMutatedMethod(AuditLogRepository.prototype, 'insert', refuseInsert, async () => {
      await expect(recordPlatformAccess({ userId }, tenantId, 'viewer')).rejects.toThrow(
        'insert failed'
      )
    })

    const redis = await getRedis()
    expect(await redis.exists(key)).toBe(0)
    await expect(recordPlatformAccess({ userId }, tenantId, 'viewer')).resolves.toBeDefined()
    expect(await auditRows(tenantId)).toHaveLength(1)
  })

  it('logs a warning and rethrows the original error when releasing the key also fails', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    trackedDedupeKey(userId, tenantId)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const redis = await getRedis()
    const failingDel = (() =>
      Promise.reject(new Error('redis del unavailable'))) as typeof redis.del

    await withMutatedMethod(redis, 'del', failingDel, async () => {
      await withMutatedMethod(AuditLogRepository.prototype, 'insert', refuseInsert, async () => {
        await expect(recordPlatformAccess({ userId }, tenantId, 'viewer')).rejects.toThrow(
          'insert failed'
        )
      })
    })

    expect(warn).toHaveBeenCalledWith('Could not release the platform access dedupe key', {
      error: 'redis del unavailable',
    })
  })
})
