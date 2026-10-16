/**
 * @file The two audit-log reads. Fixture rows are inserted directly (the
 * table allows INSERT), so equal timestamps and system actors are exact.
 */

import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

/**
 * One audit entry as the read routes return it. `tenant` is present only on the platform read.
 */
interface AuditEntryBody {
  id: string
  occurredAt: string
  action: string
  access: string
  actor: { id: string; name: string; email: string } | null
  target: { type: string; id: string } | null
  metadata: Record<string, unknown>
  tenant?: { id: string; name: string; slug: string }
}

/**
 * A page of entries and its paging block; `nextCursor` is null on the last page.
 */
interface AuditPage {
  items: AuditEntryBody[]
  page: { nextCursor: string | null; hasNext: boolean; limit: number }
}

/**
 * A controller response envelope, narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * The columns a fixture row sets. Without `actorUserId` the row is a system
 * entry; the other columns default to a `tenant.updated` action.
 */
interface SeedRow {
  tenantId: string
  actorUserId?: string
  action?: string
  access?: 'member' | 'platform' | 'system'
  occurredAt?: string
  metadata?: Record<string, unknown>
}

const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * The `data` of a 200 response.
 * @throws {Error} When the body carries no data.
 */
function pageOf(response: Response): AuditPage {
  const data = (response.body as ApiEnvelope<AuditPage>).data
  if (!data) throw new Error(`no data (status ${response.status})`)
  return data
}

/**
 * A body without its per-request `requestId`, so two bodies can be compared.
 */
function withoutRequestId(body: unknown): Record<string, unknown> {
  const copy = { ...(body as Record<string, unknown>) }
  delete copy.requestId
  return copy
}

/**
 * Read a tenant's audit log as the bearer of `token`.
 */
function readTenantLog(slug: string, token: string, query: Record<string, string> = {}) {
  return request(app)
    .get(`/api/v1/tenants/${slug}/audit-log`)
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * Read the platform-wide audit log as the bearer of `token`.
 */
function readPlatformLog(token: string, query: Record<string, string> = {}) {
  return request(app)
    .get('/api/v1/platform/audit-log')
    .query(query)
    .set('Authorization', `Bearer ${token}`)
}

/**
 * Insert one audit row directly, so timestamps and system actors are exact.
 */
async function insertRow(row: SeedRow): Promise<string> {
  const isSystem = row.actorUserId === undefined
  const [inserted] = await sql<{ id: string }[]>`
    insert into audit_logs
      (occurred_at, actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, metadata)
    values (
      ${row.occurredAt ?? new Date().toISOString()}::timestamptz,
      ${isSystem ? 'system' : 'user'},
      ${row.actorUserId ?? sql`null`},
      ${row.access ?? (isSystem ? 'system' : 'member')},
      ${row.tenantId},
      ${row.action ?? 'tenant.updated'},
      'tenant',
      ${row.tenantId},
      ${JSON.stringify(row.metadata ?? { changed: ['name'] })}::jsonb
    )
    returning id`
  if (!inserted) throw new Error('insert returned no row')
  return inserted.id
}

describe('audit-log reads', () => {
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
   * Create a tracked user and sign a bearer token for it.
   */
  async function createUser(
    names: { firstName?: string; lastName?: string } = {}
  ): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `audit-api-${randomUUID()}@example.test`,
      ...names,
    })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * Create a tracked tenant owned by a fresh user.
   */
  async function createTenant(): Promise<{ tenant: Tenant; ownerToken: string; owner: User }> {
    const { user, token } = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Audit Read Co',
      slug: `audit-read-${randomUUID()}`,
      ownerId: user.id,
    })
    createdTenantIds.push(tenant.id)
    return { tenant, ownerToken: token, owner: user }
  }

  /**
   * A bearer token for a fresh user added to `tenant` with `role`.
   */
  async function memberToken(tenant: Tenant, role: MembershipRole): Promise<string> {
    const { user, token } = await createUser()
    await userMembershipRepository.create({ userId: user.id, tenantId: tenant.id, role })
    return token
  }

  /**
   * Create a tracked user with platform role `role`, named Sam Staff.
   */
  async function staff(role: MembershipRole): Promise<{ user: User; token: string }> {
    const created = await createUser({ firstName: 'Sam', lastName: 'Staff' })
    await makeStaff(created.user.id, role)
    return created
  }

  describe('GET /api/v1/tenants/:slug/audit-log', () => {
    it.each([
      ['owner', 200],
      ['admin', 200],
      ['manager', 403],
      ['editor', 403],
      ['viewer', 403],
    ] as const)('answers a member %s with %i', async (role, status) => {
      const { tenant } = await createTenant()

      const response = await readTenantLog(tenant.slug, await memberToken(tenant, role))

      expect(response.status).toBe(status)
    })

    it.each([
      ['owner', 200],
      ['admin', 200],
      ['manager', 403],
      ['viewer', 403],
    ] as const)('answers a non-member platform %s with %i', async (role, status) => {
      const { tenant } = await createTenant()
      const { token } = await staff(role)

      const response = await readTenantLog(tenant.slug, token)

      expect(response.status).toBe(status)
    })

    it('answers 404 to a user who is neither a member nor staff', async () => {
      const { tenant } = await createTenant()
      const { token } = await createUser()

      const response = await readTenantLog(tenant.slug, token)

      expect(response.status).toBe(404)
    })

    it('shapes each entry per the contract, staff actors named with their email', async () => {
      const { tenant, ownerToken, owner } = await createTenant()
      const { user: staffUser } = await staff('admin')
      await insertRow({
        tenantId: tenant.id,
        actorUserId: owner.id,
        occurredAt: '2026-09-25T10:00:00.001Z',
      })
      await insertRow({
        tenantId: tenant.id,
        actorUserId: staffUser.id,
        access: 'platform',
        occurredAt: '2026-09-25T10:00:00.002Z',
      })
      await insertRow({
        tenantId: tenant.id,
        action: 'tenant.settings_updated',
        occurredAt: '2026-09-25T10:00:00.003Z',
      })

      const { items } = pageOf(await readTenantLog(tenant.slug, ownerToken))

      expect(items.map((entry) => entry.access)).toEqual(['system', 'platform', 'member'])
      const [system, byStaff, byOwner] = items
      expect(system?.actor).toBeNull()
      expect(byStaff?.actor).toEqual({
        id: staffUser.id,
        name: 'Sam Staff',
        email: staffUser.email,
      })
      expect(byOwner?.actor).toEqual({ id: owner.id, name: owner.email, email: owner.email })
      expect(byOwner?.target).toEqual({ type: 'tenant', id: tenant.id })
      expect(byOwner?.metadata).toEqual({ changed: ['name'] })
      expect(byOwner?.occurredAt).toMatch(ISO_MILLISECONDS)
      expect(Object.keys(byOwner ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'access',
        'action',
        'actor',
        'id',
        'metadata',
        'occurredAt',
        'target',
      ])
    })

    it("never shows another tenant's entries", async () => {
      const { tenant, ownerToken } = await createTenant()
      const { tenant: other } = await createTenant()
      const mine = await insertRow({ tenantId: tenant.id })
      await insertRow({ tenantId: other.id })

      const { items } = pageOf(await readTenantLog(tenant.slug, ownerToken))

      expect(items.map((entry) => entry.id)).toEqual([mine])
    })

    it('pages entries with equal timestamps exactly once each, newest id first', async () => {
      const { tenant, ownerToken } = await createTenant()
      const sameInstant = '2026-09-25T12:00:00.500Z'
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) {
        ids.push(await insertRow({ tenantId: tenant.id, occurredAt: sameInstant }))
      }

      const walked: string[] = []
      let cursor: string | null | undefined
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const query: Record<string, string> = { limit: '2' }
        if (typeof cursor === 'string') query.cursor = cursor
        const page = pageOf(await readTenantLog(tenant.slug, ownerToken, query))
        walked.push(...page.items.map((entry) => entry.id))
        cursor = page.page.nextCursor
      }

      expect(walked).toHaveLength(5)
      expect(new Set(walked)).toEqual(new Set(ids))
      expect(walked).toEqual(ids.toSorted((a, b) => b.localeCompare(a)))
      expect(cursor).toBeNull()
    })

    it('filters by action and by actor', async () => {
      const { tenant, ownerToken, owner } = await createTenant()
      const { user: other } = await createUser()
      const byOwner = await insertRow({ tenantId: tenant.id, actorUserId: owner.id })
      const settings = await insertRow({
        tenantId: tenant.id,
        actorUserId: other.id,
        action: 'tenant.settings_updated',
      })

      const byAction = pageOf(
        await readTenantLog(tenant.slug, ownerToken, { action: 'tenant.settings_updated' })
      )
      const byActor = pageOf(await readTenantLog(tenant.slug, ownerToken, { actor: owner.id }))

      expect(byAction.items.map((entry) => entry.id)).toEqual([settings])
      expect(byActor.items.map((entry) => entry.id)).toEqual([byOwner])
    })

    it.each([['member'], ['platform'], ['system']] as const)(
      'filters by access=%s, for the Activity tab',
      async (access) => {
        const { tenant, ownerToken, owner } = await createTenant()
        const { user: staffUser } = await staff('admin')
        const ids = {
          member: await insertRow({ tenantId: tenant.id, actorUserId: owner.id }),
          platform: await insertRow({
            tenantId: tenant.id,
            actorUserId: staffUser.id,
            access: 'platform',
          }),
          system: await insertRow({ tenantId: tenant.id }),
        }

        const page = pageOf(await readTenantLog(tenant.slug, ownerToken, { access }))

        expect(page.items.map((entry) => entry.id)).toEqual([ids[access]])
      }
    )

    it('keeps only the entries that match every filter at once', async () => {
      const { tenant, ownerToken, owner } = await createTenant()
      const { user: other } = await createUser()
      const match = await insertRow({
        tenantId: tenant.id,
        actorUserId: owner.id,
        action: 'tenant.settings_updated',
      })
      await insertRow({ tenantId: tenant.id, actorUserId: owner.id })
      await insertRow({
        tenantId: tenant.id,
        actorUserId: other.id,
        action: 'tenant.settings_updated',
      })
      await insertRow({
        tenantId: tenant.id,
        actorUserId: owner.id,
        action: 'tenant.settings_updated',
        access: 'platform',
      })

      const page = pageOf(
        await readTenantLog(tenant.slug, ownerToken, {
          action: 'tenant.settings_updated,tenant.updated',
          actor: owner.id,
          access: 'member',
          search: 'settings',
        })
      )

      expect(page.items.map((entry) => entry.id)).toEqual([match])
    })

    it('sorts newest first by default and oldest first on request', async () => {
      const { tenant, ownerToken } = await createTenant()
      const oldest = await insertRow({
        tenantId: tenant.id,
        occurredAt: '2026-09-25T10:00:00.001Z',
      })
      const middle = await insertRow({
        tenantId: tenant.id,
        occurredAt: '2026-09-25T10:00:00.002Z',
      })
      const newest = await insertRow({
        tenantId: tenant.id,
        occurredAt: '2026-09-25T10:00:00.003Z',
      })

      const byDefault = pageOf(await readTenantLog(tenant.slug, ownerToken))
      const ascending = pageOf(await readTenantLog(tenant.slug, ownerToken, { sort: 'occurred' }))

      expect(byDefault.items.map((entry) => entry.id)).toEqual([newest, middle, oldest])
      expect(ascending.items.map((entry) => entry.id)).toEqual([oldest, middle, newest])
    })

    it("cannot read another tenant's entries through a filter or a cursor", async () => {
      const { tenant, ownerToken } = await createTenant()
      const { tenant: other, ownerToken: otherToken, owner: otherOwner } = await createTenant()
      const mine = await insertRow({ tenantId: tenant.id })
      const theirs = new Set([
        await insertRow({ tenantId: other.id, actorUserId: otherOwner.id }),
        await insertRow({ tenantId: other.id, actorUserId: otherOwner.id }),
      ])
      const theirCursor = pageOf(await readTenantLog(other.slug, otherToken, { limit: '1' })).page
        .nextCursor

      const byTenant = pageOf(
        await readTenantLog(tenant.slug, ownerToken, { tenant: other.id, target: other.id })
      )
      const byActor = pageOf(await readTenantLog(tenant.slug, ownerToken, { actor: otherOwner.id }))
      const withCursor = pageOf(
        await readTenantLog(tenant.slug, ownerToken, { cursor: theirCursor ?? '' })
      )

      expect(theirCursor).toEqual(expect.any(String))
      expect(byTenant.items.map((entry) => entry.id)).toEqual([mine])
      expect(byActor.items).toEqual([])
      expect(withCursor.items.map((entry) => entry.id).filter((id) => theirs.has(id))).toEqual([])
    })

    it('defaults to 20 entries, with a cursor for the rest', async () => {
      const { tenant, ownerToken } = await createTenant()
      await sql`
        insert into audit_logs (actor_kind, access, tenant_id, action, target_type, target_id, metadata)
        select 'system', 'system', ${tenant.id}, 'tenant.updated', 'tenant', ${tenant.id}, '{"changed":["name"]}'::jsonb
        from generate_series(1, 21)`

      const page = pageOf(await readTenantLog(tenant.slug, ownerToken))

      expect(page.items).toHaveLength(20)
      expect(page.page.nextCursor).toEqual(expect.any(String))
    })

    it.each([
      ['limit', '0'],
      ['limit', '101'],
      ['action', 'tenant.exploded'],
      ['actor', 'not-a-uuid'],
      ['access', 'everyone'],
      ['cursor', '!!!'],
    ])('answers 400 for %s=%s', async (field, value) => {
      const { tenant, ownerToken } = await createTenant()

      const response = await readTenantLog(tenant.slug, ownerToken, { [field]: value })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty(field)
    })

    it("shows the platform tenant's own entries to its members", async () => {
      const { token } = await staff('owner')
      const platform = await platformTenant()
      const granted = await insertRow({
        tenantId: platform.id,
        action: 'platform.member.granted',
        metadata: { userId: randomUUID(), role: 'admin', via: 'script' },
      })

      const { items } = pageOf(await readTenantLog('platform', token))

      expect(items.map((entry) => entry.id)).toContain(granted)
    })
  })

  describe('GET /api/v1/platform/audit-log', () => {
    it.each([['owner'], ['admin']] as const)('admits a platform %s', async (role) => {
      const { token } = await staff(role)

      const response = await readPlatformLog(token)

      expect(response.status).toBe(200)
    })

    it.each([['manager'], ['editor'], ['viewer']] as const)(
      "answers a platform %s with the app's own 404",
      async (role) => {
        const { token } = await staff(role)

        const refused = await readPlatformLog(token)
        const unknown = await request(app)
          .get('/api/v1/definitely-not-a-route')
          .set('Authorization', `Bearer ${token}`)

        expect(refused.status).toBe(404)
        expect(withoutRequestId(refused.body)).toEqual(withoutRequestId(unknown.body))
      }
    )

    it('answers 404 to a user who is not staff', async () => {
      const { token } = await createUser()

      const response = await readPlatformLog(token)

      expect(response.status).toBe(404)
    })

    it('lists every tenant with its tenant, and filters by tenant, access, actor and action', async () => {
      const { token, user: staffUser } = await staff('admin')
      const { tenant: first, owner } = await createTenant()
      const { tenant: second } = await createTenant()
      const memberRow = await insertRow({ tenantId: first.id, actorUserId: owner.id })
      const staffRow = await insertRow({
        tenantId: second.id,
        actorUserId: staffUser.id,
        access: 'platform',
        action: 'tenant.accessed_by_platform',
        metadata: { platformRole: 'admin' },
      })

      const all = pageOf(await readPlatformLog(token))
      const inFirst = pageOf(await readPlatformLog(token, { tenant: first.id }))
      const staffOnly = pageOf(await readPlatformLog(token, { access: 'platform' }))
      const byActor = pageOf(await readPlatformLog(token, { actor: owner.id }))
      const byAction = pageOf(
        await readPlatformLog(token, { action: 'tenant.accessed_by_platform' })
      )

      expect(all.items.map((entry) => entry.id)).toEqual(
        expect.arrayContaining([memberRow, staffRow])
      )
      const staffEntry = all.items.find((entry) => entry.id === staffRow)
      expect(staffEntry?.tenant).toEqual({ id: second.id, name: second.name, slug: second.slug })
      expect(inFirst.items.map((entry) => entry.id)).toEqual([memberRow])
      expect(staffOnly.items.map((entry) => entry.id)).toEqual([staffRow])
      expect(byActor.items.map((entry) => entry.id)).toEqual([memberRow])
      expect(byAction.items.map((entry) => entry.id)).toEqual([staffRow])
    })

    it.each([
      ['access', 'everyone'],
      ['tenant', 'not-a-uuid'],
      ['limit', '101'],
    ])('answers 400 for %s=%s', async (field, value) => {
      const { token } = await staff('admin')

      const response = await readPlatformLog(token, { [field]: value })

      expect(response.status).toBe(400)
      expect((response.body as ApiEnvelope<unknown>).errors).toHaveProperty(field)
    })
  })
})
