// tests/integration/database/audit-purge-trigger.test.ts
//
// audit_logs' trigger as migration 0017 left it. UPDATE always raises.
// DELETE raises unless the deleting transaction set app.audit_purge to 'on'
// AND app.audit_purge_before past the row's occurred_at. Each setting is
// tested missing on its own, because a guard of the form `a and b` with no
// a-true/b-false case can lose either half unnoticed. Raw SQL throughout.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'

const OLD = '2000-06-01T00:00:00.000Z'
const CUTOFF = '2001-01-01T00:00:00.000Z'
const PURGE = { 'app.audit_purge': 'on', 'app.audit_purge_before': CUTOFF }

const createdTenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (createdTenantIds.length === 0) return
  await sql`delete from tenants where id = any(${createdTenantIds})`
  createdTenantIds.length = 0
})

/**
 * A raw tenant row, tracked for cleanup.
 * @returns Its id.
 */
async function insertTenant(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Purge Co', ${`purge-${randomUUID()}`}) returning id
  `
  if (!row) throw new Error('tenant insert returned no row')
  createdTenantIds.push(row.id)
  return row.id
}

/**
 * One system-actor audit row.
 * @param occurredAt - Its occurred_at, ISO.
 * @returns Its id.
 */
async function insertAuditRow(occurredAt: string): Promise<string> {
  const tenantId = await insertTenant()
  const [row] = await sql<{ id: string }[]>`
    insert into audit_logs (occurred_at, actor_kind, access, tenant_id, action, target_type, target_id)
    values (${occurredAt}::timestamptz, 'system', 'system', ${tenantId}, 'tenant.updated', 'tenant', ${tenantId})
    returning id
  `
  if (!row) throw new Error('audit insert returned no row')
  return row.id
}

/**
 * Delete or update one audit row in a transaction that first applies
 * `settings` with set_config(..., true).
 * @param settings - Setting name to value.
 * @param statement - Which write to attempt.
 * @param id - The row's id.
 * @returns Resolves when the transaction commits.
 */
async function inTransactionWith(
  settings: Record<string, string>,
  statement: 'delete' | 'update',
  id: string
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const [name, value] of Object.entries(settings)) {
      await tx`select set_config(${name}, ${value}, true)`
    }
    await (statement === 'delete'
      ? tx`delete from audit_logs where id = ${id}`
      : tx`update audit_logs set action = 'tenant.created' where id = ${id}`)
  })
}

/**
 * Whether an audit row still exists.
 * @param id - The row's id.
 * @returns True when it does.
 */
async function isPresent(id: string): Promise<boolean> {
  const rows = await sql`select 1 from audit_logs where id = ${id}`
  return rows.length === 1
}

describe('migration 0017: the audit purge gate', () => {
  it.each([
    ['no setting', {}],
    ['the flag without a cutoff', { 'app.audit_purge': 'on' }],
    ['a cutoff without the flag', { 'app.audit_purge_before': CUTOFF }],
    ['a flag other than on', { 'app.audit_purge': 'true', 'app.audit_purge_before': CUTOFF }],
  ])('raises on DELETE with %s, and keeps the row', async (_label, settings) => {
    const id = await insertAuditRow(OLD)
    await expect(inTransactionWith(settings, 'delete', id)).rejects.toThrow(
      'audit_logs is append-only'
    )
    expect(await isPresent(id)).toBe(true)
  })

  it('raises on DELETE of a row newer than the cutoff, with both settings on', async () => {
    const id = await insertAuditRow(new Date().toISOString())
    await expect(inTransactionWith(PURGE, 'delete', id)).rejects.toThrow(
      'audit_logs is append-only'
    )
    expect(await isPresent(id)).toBe(true)
  })

  it('deletes a row older than the cutoff when both settings are on', async () => {
    const id = await insertAuditRow(OLD)
    await inTransactionWith(PURGE, 'delete', id)
    expect(await isPresent(id)).toBe(false)
  })

  it('still raises on UPDATE with both settings on', async () => {
    const id = await insertAuditRow(OLD)
    await expect(inTransactionWith(PURGE, 'update', id)).rejects.toThrow(
      'audit_logs is append-only'
    )
  })

  it('forgets the settings when their transaction ends', async () => {
    const purged = await insertAuditRow(OLD)
    const kept = await insertAuditRow(OLD)
    await inTransactionWith(PURGE, 'delete', purged)

    await expect(sql`delete from audit_logs where id = ${kept}`).rejects.toThrow(
      'audit_logs is append-only'
    )
    expect(await isPresent(kept)).toBe(true)
  })
})
