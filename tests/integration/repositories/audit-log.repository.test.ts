// tests/integration/repositories/audit-log.repository.test.ts
//
// AuditLogRepository against the real per-worker Postgres. Every row is
// scoped to a tenant this file creates, and every listing filters by that
// tenant to stay isolated from other files' rows.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewAuditLog } from '@/database/models/audit-log.model'
import {
  AuditLogRepository,
  type AuditLogCursor,
  type AuditLogListRow,
} from '@/repositories/audit-log.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'

const auditLogRepository = new AuditLogRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const createdTenantIds: string[] = []
const createdUserIds: string[] = []

afterEach(async () => {
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
 * @returns The user's and tenant's ids.
 */
async function createOwnerAndTenant(): Promise<{ userId: string; tenantId: string }> {
  const user = await userRepository.create({
    email: `audit-repo-${randomUUID()}@example.test`,
    firstName: 'Ada',
    lastName: 'Lovelace',
  })
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
 * A valid user-actor entry for `tenantId`, with any columns overridden.
 * @param tenantId - The tenant.
 * @param userId - The actor.
 * @param overrides - Columns to override.
 * @returns The insert values.
 */
function entry(
  tenantId: string,
  userId: string,
  overrides: Partial<NewAuditLog> = {}
): NewAuditLog {
  return {
    actorKind: 'user',
    actorUserId: userId,
    access: 'member',
    tenantId,
    action: 'tenant.updated',
    targetType: 'tenant',
    targetId: tenantId,
    metadata: { changed: ['name'] },
    ...overrides,
  }
}

/**
 * Read a tenant's whole log a page at a time.
 * @param tenantId - The tenant.
 * @param limit - The page size.
 * @returns Every row, in page order, and how many pages it took.
 */
async function readAllPages(
  tenantId: string,
  limit: number
): Promise<{ rows: AuditLogListRow[]; pages: number }> {
  const rows: AuditLogListRow[] = []
  let cursor: AuditLogCursor | undefined
  let pages = 0
  do {
    const page = await auditLogRepository.list({ tenantId, limit, cursor })
    rows.push(...page.rows)
    pages += 1
    cursor = page.nextCursor
  } while (cursor !== undefined && pages < 20)
  return { rows, pages }
}

describe('AuditLogRepository.insert', () => {
  it('returns the row with its generated id and timestamp, and {} metadata by default', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()

    const row = await auditLogRepository.insert(entry(tenantId, userId, { metadata: undefined }))

    expect(row.id).toMatch(/^[\da-f-]{36}$/)
    expect(row.occurredAt).toBeInstanceOf(Date)
    expect(row.metadata).toEqual({})
  })
})

describe('AuditLogRepository.list, one tenant', () => {
  it('pages newest first without duplicates or gaps across equal timestamps', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const shared = new Date('2026-09-25T10:00:00.123Z')
    await auditLogRepository.insert(
      entry(tenantId, userId, { occurredAt: new Date('2026-09-25T09:00:00.000Z') })
    )
    for (let index = 0; index < 3; index += 1) {
      await auditLogRepository.insert(entry(tenantId, userId, { occurredAt: shared }))
    }
    await auditLogRepository.insert(
      entry(tenantId, userId, { occurredAt: new Date('2026-09-25T11:00:00.000Z') })
    )

    const everything = await auditLogRepository.list({ tenantId, limit: 100 })
    const paged = await readAllPages(tenantId, 2)

    expect(everything.nextCursor).toBeUndefined()
    expect(everything.rows).toHaveLength(5)
    expect(paged.pages).toBe(3)
    expect(paged.rows.map((row) => row.entry.id)).toEqual(
      everything.rows.map((row) => row.entry.id)
    )
    expect(new Set(paged.rows.map((row) => row.entry.id)).size).toBe(5)
    const times = everything.rows.map((row) => row.entry.occurredAt.getTime())
    expect(times).toEqual([...times].toSorted((a, b) => b - a))
    expect(times.filter((time) => time === shared.getTime())).toHaveLength(3)
  })

  it('returns no cursor on the last page', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(entry(tenantId, userId))

    const exact = await auditLogRepository.list({ tenantId, limit: 2 })

    expect(exact.rows).toHaveLength(2)
    expect(exact.nextCursor).toBeUndefined()
  })

  it('returns only the tenant’s own rows, filtered by action and actor', async () => {
    const first = await createOwnerAndTenant()
    const second = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(first.tenantId, first.userId))
    await auditLogRepository.insert(
      entry(first.tenantId, second.userId, {
        action: 'tenant.settings_updated',
        targetType: 'settings',
      })
    )
    await auditLogRepository.insert(entry(second.tenantId, second.userId))

    const all = await auditLogRepository.list({ tenantId: first.tenantId, limit: 10 })
    const byAction = await auditLogRepository.list({
      tenantId: first.tenantId,
      limit: 10,
      action: 'tenant.settings_updated',
    })
    const byActor = await auditLogRepository.list({
      tenantId: first.tenantId,
      limit: 10,
      actorUserId: first.userId,
    })

    expect(all.rows).toHaveLength(2)
    expect(all.rows.every((row) => row.entry.tenantId === first.tenantId)).toBe(true)
    expect(byAction.rows.map((row) => row.entry.actorUserId)).toEqual([second.userId])
    expect(byActor.rows.map((row) => row.entry.action)).toEqual(['tenant.updated'])
  })

  it('joins the actor’s public fields, and gives a system entry a null actor', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(
      entry(tenantId, userId, { actorKind: 'system', actorUserId: undefined, access: 'system' })
    )

    const { rows } = await auditLogRepository.list({ tenantId, limit: 10 })
    const userRow = rows.find((row) => row.entry.actorKind === 'user')
    const systemRow = rows.find((row) => row.entry.actorKind === 'system')

    expect(userRow?.actor).toEqual({
      id: userId,
      email: expect.stringContaining('@example.test') as string,
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    expect(userRow?.actor).not.toHaveProperty('passwordHash')
    expect(systemRow?.actor).toBeNull()
  })
})

describe('AuditLogRepository.list, with its tenant', () => {
  it('attaches each row’s tenant and filters by tenant, access and action', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(
      entry(tenantId, userId, {
        access: 'platform',
        action: 'tenant.accessed_by_platform',
        metadata: { platformRole: 'viewer' },
      })
    )

    const scoped = await auditLogRepository.list({ limit: 10, tenantId })
    const staffOnly = await auditLogRepository.list({ limit: 10, tenantId, access: 'platform' })
    const byAction = await auditLogRepository.list({
      limit: 10,
      tenantId,
      action: 'tenant.updated',
    })

    expect(scoped.rows).toHaveLength(2)
    expect(scoped.rows[0]?.tenant).toEqual({
      id: tenantId,
      name: 'Audit Co',
      slug: expect.stringMatching(/^audit-/) as string,
    })
    expect(staffOnly.rows.map((row) => row.entry.action)).toEqual(['tenant.accessed_by_platform'])
    expect(byAction.rows.map((row) => row.entry.access)).toEqual(['member'])
  })

  it('pages the platform-wide log by the same keyset', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const shared = new Date('2026-09-25T12:00:00.500Z')
    for (let index = 0; index < 3; index += 1) {
      await auditLogRepository.insert(entry(tenantId, userId, { occurredAt: shared }))
    }

    const first = await auditLogRepository.list({ limit: 2, tenantId })
    const second = await auditLogRepository.list({
      limit: 2,
      tenantId,
      cursor: first.nextCursor,
    })

    expect(first.rows).toHaveLength(2)
    expect(second.rows).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    const ids = [...first.rows, ...second.rows].map((row) => row.entry.id)
    expect(new Set(ids).size).toBe(3)
  })
})
