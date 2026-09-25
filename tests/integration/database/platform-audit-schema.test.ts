// tests/integration/database/platform-audit-schema.test.ts
//
// What migration 0016 built, asserted against the live per-worker database:
// the seeded platform tenant and its constraints, and audit_logs' CHECKs,
// append-only trigger (UPDATE and DELETE; TRUNCATE is open) and RESTRICT
// foreign keys. Raw SQL throughout, so no
// application check stands in for the database's.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'

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
 * A raw user row, tracked for cleanup.
 * @returns The user's id.
 */
async function insertUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email) values (${`schema-${randomUUID()}@example.test`}) returning id
  `
  if (!row) throw new Error('user insert returned no row')
  createdUserIds.push(row.id)
  return row.id
}

/**
 * A raw customer tenant row, tracked for cleanup.
 * @returns The tenant's id.
 */
async function insertTenant(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Schema Co', ${`schema-${randomUUID()}`}) returning id
  `
  if (!row) throw new Error('tenant insert returned no row')
  createdTenantIds.push(row.id)
  return row.id
}

/**
 * The platform tenant's id.
 * @returns The id of the one `is_platform` row.
 */
async function platformTenantId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from tenants where is_platform`
  if (!row) throw new Error('no platform tenant')
  return row.id
}

/**
 * Insert one valid user-actor audit row.
 * @param tenantId - The tenant it belongs to.
 * @param userId - The actor.
 * @returns The row's id.
 */
async function insertAuditRow(tenantId: string, userId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id)
    values ('user', ${userId}, 'member', ${tenantId}, 'tenant.created', 'tenant', ${tenantId})
    returning id
  `
  if (!row) throw new Error('audit insert returned no row')
  return row.id
}

describe('migration 0016: the platform tenant', () => {
  it('seeds exactly one active platform tenant with a settings row', async () => {
    const rows = await sql`
      select t.name, t.slug, t.lifecycle_state, t.deleted_at, s.tenant_id as settings_tenant_id
      from tenants t left join tenant_settings s on s.tenant_id = t.id
      where t.is_platform
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Platform', slug: 'platform', lifecycle_state: 'active' })
    expect(rows[0]?.deleted_at).toBeNull()
    expect(rows[0]?.settings_tenant_id).toBeTruthy()
  })

  it('defaults is_platform to false for a new tenant', async () => {
    const tenantId = await insertTenant()
    const [row] = await sql`select is_platform from tenants where id = ${tenantId}`
    expect(row?.is_platform).toBe(false)
  })

  it('refuses a second platform tenant (tenants_single_platform)', async () => {
    const slug = `p-${randomUUID()}`
    await expect(
      sql`insert into tenants (name, slug, is_platform) values ('Other', ${slug}, true)`
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'tenants_single_platform' })
  })

  it.each([
    ['suspending', () => sql`update tenants set lifecycle_state = 'suspended' where is_platform`],
    ['archiving', () => sql`update tenants set lifecycle_state = 'archived' where is_platform`],
    ['soft-deleting', () => sql`update tenants set deleted_at = now() where is_platform`],
  ])('refuses %s it (tenants_platform_active)', async (_label, statement) => {
    await expect(statement()).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'tenants_platform_active',
    })
    const [row] = await sql`select lifecycle_state, deleted_at from tenants where is_platform`
    expect(row?.lifecycle_state).toBe('active')
    expect(row?.deleted_at).toBeNull()
  })

  it('installs pg_trgm and both trigram indexes, partial on live tenants', async () => {
    const extensions = await sql`select 1 from pg_extension where extname = 'pg_trgm'`
    expect(extensions).toHaveLength(1)
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where tablename = 'tenants' and indexname in ('tenants_name_trgm_idx', 'tenants_slug_trgm_idx')
      order by indexname
    `
    expect(indexes.map((index) => index.indexname)).toEqual([
      'tenants_name_trgm_idx',
      'tenants_slug_trgm_idx',
    ])
    for (const index of indexes) {
      expect(index.indexdef).toContain('USING gin')
      expect(index.indexdef).toContain('gin_trgm_ops')
      expect(index.indexdef).toContain('WHERE (deleted_at IS NULL)')
    }
  })
})

describe('migration 0016: audit_logs constraints', () => {
  it('accepts a user entry and a system entry', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    await insertAuditRow(tenantId, userId)
    await expect(
      sql`
        insert into audit_logs (actor_kind, access, tenant_id, action)
        values ('system', 'system', ${tenantId}, 'platform.member.granted')
      `
    ).resolves.toBeDefined()
  })

  it.each([
    [
      'a system actor with a user id',
      'audit_logs_actor_user_check',
      (tenantId: string, userId: string) => sql`
        insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action)
        values ('system', ${userId}, 'system', ${tenantId}, 'tenant.created')
      `,
    ],
    [
      'a user actor with no user id',
      'audit_logs_actor_user_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action)
        values ('user', 'member', ${tenantId}, 'tenant.created')
      `,
    ],
    [
      'an unknown actor kind',
      'audit_logs_actor_kind_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action)
        values ('robot', 'system', ${tenantId}, 'tenant.created')
      `,
    ],
    [
      'an unknown access',
      'audit_logs_access_check',
      (tenantId: string, userId: string) => sql`
        insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action)
        values ('user', ${userId}, 'guest', ${tenantId}, 'tenant.created')
      `,
    ],
    [
      'an action with no dot',
      'audit_logs_action_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action)
        values ('system', 'system', ${tenantId}, 'tenant')
      `,
    ],
    [
      'an action with capitals',
      'audit_logs_action_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action)
        values ('system', 'system', ${tenantId}, 'Tenant.Created')
      `,
    ],
    [
      'a target type with no target id',
      'audit_logs_target_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action, target_type)
        values ('system', 'system', ${tenantId}, 'tenant.created', 'tenant')
      `,
    ],
    [
      'an unknown target type',
      'audit_logs_target_type_check',
      (tenantId: string) => sql`
        insert into audit_logs (actor_kind, access, tenant_id, action, target_type, target_id)
        values ('system', 'system', ${tenantId}, 'tenant.created', 'project', ${tenantId})
      `,
    ],
  ])('refuses %s (%s)', async (_label, constraint, statement) => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    await expect(statement(tenantId, userId)).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraint,
    })
  })
})

describe('migration 0016: audit_logs is append-only', () => {
  it('raises on UPDATE and leaves the row unchanged', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    const id = await insertAuditRow(tenantId, userId)

    await expect(
      sql`update audit_logs set action = 'tenant.updated' where id = ${id}`
    ).rejects.toThrow('audit_logs is append-only')
    const [row] = await sql`select action from audit_logs where id = ${id}`
    expect(row?.action).toBe('tenant.created')
  })

  it('raises on DELETE and keeps the row', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    const id = await insertAuditRow(tenantId, userId)

    await expect(sql`delete from audit_logs where id = ${id}`).rejects.toThrow(
      'audit_logs is append-only'
    )
    expect(await sql`select 1 from audit_logs where id = ${id}`).toHaveLength(1)
  })

  it('blocks a hard delete of a tenant with audit rows (RESTRICT, no cascade)', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    await insertAuditRow(tenantId, userId)

    // ON DELETE RESTRICT raises restrict_violation (23001), not 23503.
    await expect(sql`delete from tenants where id = ${tenantId}`).rejects.toMatchObject({
      code: '23001',
      constraint_name: 'audit_logs_tenant_id_tenants_id_fk',
    })
    expect(await sql`select 1 from tenants where id = ${tenantId}`).toHaveLength(1)
  })

  it('blocks a hard delete of a user who acted (RESTRICT, no cascade)', async () => {
    const userId = await insertUser()
    const tenantId = await platformTenantId()
    await insertAuditRow(tenantId, userId)

    await expect(sql`delete from users where id = ${userId}`).rejects.toMatchObject({
      code: '23001',
      constraint_name: 'audit_logs_actor_user_id_users_id_fk',
    })
  })

  it('leaves TRUNCATE open for resets, and the trigger still guards DELETE after it', async () => {
    const userId = await insertUser()
    const tenantId = await insertTenant()
    await insertAuditRow(tenantId, userId)

    await truncateAuditLogs()

    expect(await sql`select 1 from audit_logs`).toHaveLength(0)
    const id = await insertAuditRow(tenantId, userId)
    await expect(sql`delete from audit_logs where id = ${id}`).rejects.toThrow(
      'audit_logs is append-only'
    )
  })
})
