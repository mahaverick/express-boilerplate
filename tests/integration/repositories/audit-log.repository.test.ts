/**
 * @file `AuditLogRepository` against the real per-worker Postgres. Every
 * row is scoped to a tenant this file creates, and every listing filters
 * by that tenant to stay isolated from other files' rows.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { NewAuditLog } from '@/database/models/audit-log.model'
import {
  AuditLogRepository,
  type AuditLogFilters,
  type AuditLogListRow,
} from '@/repositories/audit-log.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { tenantAuditLogListSchema } from '@/validators/audit.validators'
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
 * Creates a user and a tenant they own, both tracked for cleanup.
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
 * A valid entry for `tenantId` with `userId` as the acting user, with any columns overridden.
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
 * The shared list params the controller would parse from `query`.
 */
function paramsOf(query: Record<string, string> = {}) {
  return tenantAuditLogListSchema.parse(query).params
}

/**
 * Reads a tenant's log `limit` rows at a time, giving the rows in page order and the page count.
 * It stops after 20 pages, so a cursor that never ends fails the test instead of hanging it.
 */
async function readAllPages(
  filters: AuditLogFilters,
  limit: number
): Promise<{ rows: AuditLogListRow[]; pages: number }> {
  const rows: AuditLogListRow[] = []
  let cursor: string | null | undefined
  let pages = 0
  do {
    const query: Record<string, string> = { limit: String(limit) }
    if (typeof cursor === 'string') query.cursor = cursor
    const page = await auditLogRepository.list(paramsOf(query), filters)
    rows.push(...page.items)
    pages += 1
    cursor = page.page.nextCursor
  } while (typeof cursor === 'string' && pages < 20)
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

    const everything = await auditLogRepository.list(paramsOf({ limit: '100' }), {
      tenantId,
      scope: 'tenant',
    })
    const paged = await readAllPages({ tenantId, scope: 'tenant' }, 2)

    expect(everything.page.nextCursor).toBeNull()
    expect(everything.items).toHaveLength(5)
    expect(paged.pages).toBe(3)
    expect(paged.rows.map((row) => row.entry.id)).toEqual(
      everything.items.map((row) => row.entry.id)
    )
    expect(new Set(paged.rows.map((row) => row.entry.id)).size).toBe(5)
    const times = everything.items.map((row) => row.entry.occurredAt.getTime())
    expect(times).toEqual([...times].toSorted((a, b) => b - a))
    expect(times.filter((time) => time === shared.getTime())).toHaveLength(3)
  })

  it('returns no cursor on the last page', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(entry(tenantId, userId))

    const exact = await auditLogRepository.list(paramsOf({ limit: '2' }), {
      tenantId,
      scope: 'tenant',
    })

    expect(exact.items).toHaveLength(2)
    expect(exact.page.nextCursor).toBeNull()
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

    const all = await auditLogRepository.list(paramsOf(), {
      tenantId: first.tenantId,
      scope: 'tenant',
    })
    const byAction = await auditLogRepository.list(paramsOf(), {
      tenantId: first.tenantId,
      scope: 'tenant',
      actions: ['tenant.settings_updated'],
    })
    const byActor = await auditLogRepository.list(paramsOf(), {
      tenantId: first.tenantId,
      scope: 'tenant',
      actorUserId: first.userId,
    })

    expect(all.items).toHaveLength(2)
    expect(all.items.every((row) => row.entry.tenantId === first.tenantId)).toBe(true)
    expect(byAction.items.map((row) => row.entry.actorUserId)).toEqual([second.userId])
    expect(byActor.items.map((row) => row.entry.action)).toEqual(['tenant.updated'])
  })

  it('joins the actor’s public fields, and gives a system entry a null actor', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(
      entry(tenantId, userId, { actorKind: 'system', actorUserId: undefined, access: 'system' })
    )

    const { items: rows } = await auditLogRepository.list(paramsOf(), { tenantId, scope: 'tenant' })
    const userRow = rows.find((row) => row.entry.actorKind === 'user')
    const systemRow = rows.find((row) => row.entry.actorKind === 'system')

    expect(userRow?.actor).toEqual({
      id: userId,
      email: expect.stringContaining('@example.test') as string,
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    expect(userRow?.actor).not.toHaveProperty('emailVerifiedAt')
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

    const scoped = await auditLogRepository.list(paramsOf(), { tenantId, scope: 'tenant' })
    const staffOnly = await auditLogRepository.list(paramsOf(), {
      tenantId,
      scope: 'tenant',
      access: ['platform'],
    })
    const byAction = await auditLogRepository.list(paramsOf(), {
      tenantId,
      scope: 'tenant',
      actions: ['tenant.updated'],
    })

    expect(scoped.items).toHaveLength(2)
    expect(scoped.items[0]?.tenant).toEqual({
      id: tenantId,
      name: 'Audit Co',
      slug: expect.stringMatching(/^audit-/) as string,
      timezone: 'UTC',
    })
    expect(staffOnly.items.map((row) => row.entry.action)).toEqual(['tenant.accessed_by_platform'])
    expect(byAction.items.map((row) => row.entry.access)).toEqual(['member'])
  })

  it('pages the platform-wide log by the same keyset', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const shared = new Date('2026-09-25T12:00:00.500Z')
    for (let index = 0; index < 3; index += 1) {
      await auditLogRepository.insert(entry(tenantId, userId, { occurredAt: shared }))
    }

    const first = await auditLogRepository.list(paramsOf({ limit: '2' }), {
      tenantId,
      scope: 'tenant',
    })
    const second = await auditLogRepository.list(
      paramsOf({ limit: '2', cursor: first.page.nextCursor ?? '' }),
      { tenantId, scope: 'tenant' }
    )

    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(1)
    expect(second.page.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map((row) => row.entry.id)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('AuditLogRepository.list, search', () => {
  it('matches the action, the actor’s email, a user target’s email and a tenant target’s name', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const target = await userRepository.create({
      email: `audit-target-${randomUUID()}@example.test`,
    })
    createdUserIds.push(target.id)
    await auditLogRepository.insert(entry(tenantId, userId))
    await auditLogRepository.insert(
      entry(tenantId, userId, { action: 'tenant.settings_updated', targetType: 'settings' })
    )
    await auditLogRepository.insert(
      entry(tenantId, userId, {
        action: 'user.updated',
        targetType: 'user',
        targetId: target.id,
      })
    )
    /**
     * The actions the search finds in this tenant, under any extra filters.
     */
    const search = async (text: string, filters: Partial<AuditLogFilters> = {}) => {
      const page = await auditLogRepository.list(paramsOf({ search: text }), {
        tenantId,
        scope: 'platform',
        ...filters,
      })
      return page.items.map((row) => row.entry.action)
    }

    expect(await search('settings_updated')).toEqual(['tenant.settings_updated'])
    expect(await search('audit-repo-')).toHaveLength(3)
    expect(await search('audit-target-')).toEqual(['user.updated'])
    expect(await search('audit co')).toEqual(['tenant.updated'])
    expect(await search('audit co', { actions: ['user.updated'] })).toEqual([])
  })

  it('does not let a tenant read search a target outside the tenant', async () => {
    const { userId, tenantId } = await createOwnerAndTenant()
    const outsider = await userRepository.create({
      email: `audit-outsider-${randomUUID()}@example.test`,
    })
    createdUserIds.push(outsider.id)
    const elsewhere = await createOwnerAndTenant()
    // A staff action filed under this tenant, naming a user who is not a member and a tenant that is not this one.
    await auditLogRepository.insert(
      entry(tenantId, userId, { action: 'user.updated', targetType: 'user', targetId: outsider.id })
    )
    await auditLogRepository.insert(
      entry(tenantId, userId, {
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: elsewhere.tenantId,
      })
    )
    /**
     * How many entries the search finds in this tenant.
     */
    const found = async (text: string, scope: 'tenant' | 'platform') => {
      const page = await auditLogRepository.list(paramsOf({ search: text }), {
        tenantId,
        scope,
      })
      return page.items.length
    }

    // Positive control: an entry targeting its own tenant is found by the tenant's name; the foreign tenant, with the same name, is not.
    await auditLogRepository.insert(
      entry(tenantId, userId, {
        action: 'tenant.updated',
        targetType: 'tenant',
        targetId: tenantId,
      })
    )

    expect(await found('audit-outsider-', 'tenant')).toBe(0)
    expect(await found('audit co', 'tenant')).toBe(1)
    // The platform read still searches targets outside the tenant.
    expect(await found('audit-outsider-', 'platform')).toBe(1)
  })
})
