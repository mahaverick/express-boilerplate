/**
 * @file What migrations 0038 and 0039 built, asserted against the live
 * per-worker database in raw SQL: the tax tables' CHECKs and unique indexes,
 * purge survival of issued documents, and the subscription role column.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { sql } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetTaxDocuments } from '../../helpers/tax'

const createdTenantIds: string[] = []

/**
 * Clears tax rows, audit rows and this file's tenants.
 */
async function cleanUp(): Promise<void> {
  await resetTaxDocuments()
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
}

beforeEach(cleanUp)
afterEach(cleanUp)

/**
 * Inserts a raw tenant, tracked for cleanup, and returns its id.
 */
async function insertTenant(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into tenants (name, slug) values ('Tax Co', ${`tax-${randomUUID()}`}) returning id
  `
  if (!row) throw new Error('tenant insert returned no row')
  createdTenantIds.push(row.id)
  return row.id
}

const SNAPSHOT = sql`'{"version":1}'::jsonb`

/** Overrides for one inserted tax document. */
interface DocumentOptions {
  type?: string
  number?: string
  paymentId?: string | null
  refundId?: string | null
  originalId?: string | null
  tenantId?: string | null
  total?: number
  taxable?: number
  cgst?: number
  sgst?: number
  igst?: number
}

/** Inserts one tax document with valid defaults, overridden per case. */
async function insertDocument(o: DocumentOptions = {}): Promise<string> {
  const type = o.type ?? 'invoice'
  const number = o.number ?? `N${randomUUID().slice(0, 8)}`
  const paymentId = o.paymentId === undefined ? `pay_${randomUUID().slice(0, 12)}` : o.paymentId
  const [row] = await sql<{ id: string }[]>`
    insert into tax_documents (type, number, financial_year, issued_at, tenant_id, provider,
      provider_mode, payment_id, refund_id, original_document_id, total_minor, taxable_minor,
      cgst_minor, sgst_minor, igst_minor, supply, place_of_supply, snapshot)
    values (${type}, ${number}, '26-27', now(), ${o.tenantId ?? null}, 'fake', 'test',
      ${paymentId}, ${o.refundId ?? null}, ${o.originalId ?? null}, ${o.total ?? 118},
      ${o.taxable ?? 100}, ${o.cgst ?? 0}, ${o.sgst ?? 0}, ${o.igst ?? 18}, 'inter', '29',
      ${SNAPSHOT})
    returning id
  `
  if (!row) throw new Error('document insert returned no row')
  return row.id
}

/**
 * Inserts a tax details row with valid defaults, overridden per case.
 */
async function insertDetails(tenantId: string, fields: Record<string, unknown>): Promise<void> {
  const f = { gstin: null, state: '29', sez: false, ...fields }
  await sql`
    insert into tenant_tax_details (tenant_id, gstin, legal_name, state_code, is_sez)
    values (${tenantId}, ${f.gstin as string | null}, 'Legal Co', ${f.state as string | null},
      ${f.sez})
  `
}

/**
 * Runs a statement and returns the Postgres error code it raised, if any.
 */
async function code(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('tenant_tax_details CHECKs', () => {
  it('refuses a malformed GSTIN', async () => {
    const t = await insertTenant()
    expect(await code(insertDetails(t, { gstin: '29abcde1234f1z5' }))).toBe('23514')
  })

  it('refuses SEZ without a GSTIN', async () => {
    const t = await insertTenant()
    expect(await code(insertDetails(t, { sez: true }))).toBe('23514')
  })

  it('refuses a state that is not the GSTIN prefix', async () => {
    const t = await insertTenant()
    expect(await code(insertDetails(t, { gstin: '29ABCDE1234F1Z5', state: '27' }))).toBe('23514')
  })

  it('refuses a missing state', async () => {
    const t = await insertTenant()
    expect(await code(insertDetails(t, { state: null }))).toBe('23502')
  })

  it('accepts a matching GSTIN and state', async () => {
    const t = await insertTenant()
    expect(await code(insertDetails(t, { gstin: '29ABCDE1234F1Z5' }))).toBeUndefined()
  })
})

describe('tax_documents CHECKs and uniques', () => {
  it('refuses an invoice without a payment id', async () => {
    expect(await code(insertDocument({ paymentId: null }))).toBe('23514')
  })

  it('refuses an invoice that names an original document or a refund', async () => {
    const invoice = await insertDocument()
    expect(await code(insertDocument({ originalId: invoice }))).toBe('23514')
    expect(await code(insertDocument({ refundId: 'rfnd_on_invoice' }))).toBe('23514')
  })

  it('refuses total that is not the sum of parts', async () => {
    expect(await code(insertDocument({ total: 119 }))).toBe('23514')
  })

  it('refuses a credit note without an original', async () => {
    expect(await code(insertDocument({ type: 'credit_note', paymentId: null }))).toBe('23514')
  })

  it('refuses a second invoice for one payment', async () => {
    await insertDocument({ paymentId: 'pay_dup' })
    expect(await code(insertDocument({ paymentId: 'pay_dup' }))).toBe('23505')
  })

  it('refuses a second credit note for one refund', async () => {
    const invoice = await insertDocument()
    await insertDocument({ type: 'credit_note', originalId: invoice, refundId: 'rfnd_1' })
    expect(
      await code(insertDocument({ type: 'credit_note', originalId: invoice, refundId: 'rfnd_1' }))
    ).toBe('23505')
  })

  it('allows two manual credit notes (no refund id) on one invoice', async () => {
    const invoice = await insertDocument()
    await insertDocument({ type: 'credit_note', originalId: invoice, paymentId: null })
    expect(
      await code(insertDocument({ type: 'credit_note', originalId: invoice, paymentId: null }))
    ).toBeUndefined()
  })
})

describe('tax_document_counters CHECK', () => {
  it('takes the two document types and refuses any other', async () => {
    expect(
      await code(sql`
        insert into tax_document_counters (type, financial_year, last_number)
        values ('invoice', '26-27', 0), ('credit_note', '26-27', 0)`)
    ).toBeUndefined()
    expect(
      await code(sql`
        insert into tax_document_counters (type, financial_year, last_number)
        values ('receipt', '26-27', 0)`)
    ).toBe('23514')
  })

  it("reads held on a row that existed before the column, through the migration's own statement", async () => {
    const t = await insertTenant()
    const subscriptionId = `sub_${randomUUID().slice(0, 12)}`
    const migration = readFileSync('src/database/migrations/0038_gst_tax_documents.sql', 'utf8')
    const addColumn = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim().replace(/;$/, ''))
      .find((statement) => statement.includes('ADD COLUMN "role"'))
    if (addColumn === undefined) throw new Error('0038 has no role column statement')
    let role: string | undefined

    // Rebuild the column inside a transaction that rolls back, so the shared schema is untouched.
    const rolledBack = new Error('roll back')
    const outcome = await sql
      .begin(async (tx) => {
        await tx`alter table tenant_billing_subscriptions drop column role`
        await tx`
          insert into tenant_billing_subscriptions (tenant_id, provider, mode, subscription_id)
          values (${t}, 'fake', 'test', ${subscriptionId})`
        await tx.unsafe(addColumn)
        const [row] = await tx<{ role: string }[]>`
          select role from tenant_billing_subscriptions where subscription_id = ${subscriptionId}`
        role = row?.role
        throw rolledBack
      })
      .catch((error: unknown) => error)

    expect(outcome).toBe(rolledBack)
    expect(role).toBe('held')
    const [column] = await sql<{ count: number }[]>`
      select count(*)::int as count from information_schema.columns
      where table_name = 'tenant_billing_subscriptions' and column_name = 'role'`
    expect(column?.count).toBe(1)
  })
})

describe('purge survival', () => {
  it('nulls a purged tenant document link, keeps the document, drops details and held charges', async () => {
    const t = await insertTenant()
    const document = await insertDocument({ tenantId: t })
    await insertDetails(t, {})
    await sql`
      insert into tax_held_charges (tenant_id, provider, provider_mode, payment_id, amount_minor, paid_at)
      values (${t}, 'fake', 'test', 'pay_held', 118, now())
    `
    await sql`delete from tenants where id = ${t}`
    createdTenantIds.length = 0
    const [kept] = await sql<{ tenant_id: string | null }[]>`
      select tenant_id from tax_documents where id = ${document}
    `
    expect(kept).toEqual({ tenant_id: null })
    expect(await sql`select 1 from tenant_tax_details where tenant_id = ${t}`).toHaveLength(0)
    expect(await sql`select 1 from tax_held_charges where tenant_id = ${t}`).toHaveLength(0)
  })
})

describe('tenant_billing_subscriptions.role', () => {
  it('defaults to held and refuses an unknown role', async () => {
    const t = await insertTenant()
    const [row] = await sql<{ role: string }[]>`
      insert into tenant_billing_subscriptions (tenant_id, provider, mode, subscription_id)
      values (${t}, 'fake', 'test', ${`sub_${randomUUID().slice(0, 12)}`}) returning role
    `
    expect(row?.role).toBe('held')
    expect(
      await code(sql`
        insert into tenant_billing_subscriptions (tenant_id, provider, mode, subscription_id, role)
        values (${t}, 'fake', 'test', 'sub_bad', 'bogus')
      `)
    ).toBe('23514')
  })
})
