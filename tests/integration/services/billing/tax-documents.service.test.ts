/**
 * @file Issuing tax documents against the real per-worker database: invoice
 * numbers and tax splits, the buyer snapshot, the SEZ hold, credit notes
 * that add up to their invoice, the late credit note rule, the audit entries
 * and the staff credit note's role re-check.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import {
  buildSnapshot,
  issueCreditNote,
  issueInvoice,
} from '@/services/billing/tax-documents.service'
import { sql, withTransaction } from '@/services/database.service'
import type { ProviderCharge } from '@/types/billing'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { platformTenant } from '../../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'
import { resetTaxDocuments } from '../../../helpers/tax'
import { FIXTURE_SELLER } from '../../../helpers/tax-seller'

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => seller,
  }
})

const taxRepository = new TaxRepository()
const tenantRepository = new TenantRepository()
const scope = { kind: 'razorpay', mode: 'test' } as const
const ISSUED_AT = new Date('2026-10-27T06:30:00.000Z')
const INTRA_GSTIN = '29ABCDE1234F1ZW'
const INTER_GSTIN = '27ABCDE1234F1Z0'

const tenantIds: string[] = []

beforeEach(resetTaxDocuments)

afterEach(async () => {
  await resetTaxDocuments()
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A workspace with its billing row and owner.
 */
async function workspace(name = 'Acme Studio'): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name,
    slug: `tax-issue-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * Save a workspace's tax details as its owner would.
 */
async function saveDetails(
  tenantId: string,
  ownerId: string,
  details: { gstin: string | null; stateCode: string; isSez?: boolean }
): Promise<void> {
  await withTransaction((tx) =>
    taxRepository.insertDetails(
      {
        tenantId,
        gstin: details.gstin,
        legalName: 'Acme Studio Pvt Ltd',
        addressLine1: '4 Park Street',
        addressLine2: null,
        city: 'Pune',
        pincode: '411001',
        stateCode: details.stateCode,
        isSez: details.isSez ?? false,
        updatedBy: ownerId,
      },
      tx
    )
  )
}

/**
 * A paid charge of `amountMinor` with fresh ids.
 */
function charge(amountMinor = 99_900): ProviderCharge & { description: string } {
  return {
    invoiceId: `inv_${randomUUID().slice(0, 12)}`,
    subscriptionId: `sub_${randomUUID().slice(0, 12)}`,
    paymentId: `pay_${randomUUID().slice(0, 12)}`,
    amountMinor,
    paidAt: new Date('2026-10-26T05:00:00.000Z'),
    billingStart: new Date('2026-10-26T05:00:00.000Z'),
    billingEnd: new Date('2026-11-26T05:00:00.000Z'),
    description: 'Paid, Monthly, 26 Oct 2026 to 26 Nov 2026',
  }
}

/**
 * The last number of a series, or undefined when it has none.
 */
async function counter(type: string, financialYear: string): Promise<number | undefined> {
  const rows = await sql<{ last_number: number }[]>`
    select last_number from tax_document_counters
    where type = ${type} and financial_year = ${financialYear}
  `
  return rows[0]?.last_number
}

/**
 * Issue an invoice and fail the test unless it was issued.
 */
async function issued(tenantId: string, paid = charge()) {
  const result = await issueInvoice(tenantId, paid, scope, ISSUED_AT)
  if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
  return result.document
}

/**
 * The audit rows written for a workspace, oldest first.
 */
async function auditRows(tenantId: string) {
  const rows = await sql<
    {
      action: string
      target_type: string
      target_id: string
      access: string
      actor_kind: string
      actor_user_id: string | null
      metadata: Record<string, unknown>
    }[]
  >`
    select action, target_type, target_id, access, actor_kind, actor_user_id, metadata
    from audit_logs where tenant_id = ${tenantId} order by occurred_at, id
  `
  // A plain array: the driver's result carries extra fields a strict compare would see.
  return [...rows]
}

describe('issueInvoice', () => {
  it('issues the first invoice of the year to an intra-state buyer', async () => {
    const { tenant, owner } = await workspace()
    await saveDetails(tenant.id, owner.id, { gstin: INTRA_GSTIN, stateCode: '29' })
    const paid = charge()

    const document = await issued(tenant.id, paid)

    expect(document).toMatchObject({
      type: 'invoice',
      number: 'INV/26-27/00001',
      financialYear: '26-27',
      tenantId: tenant.id,
      provider: 'razorpay',
      providerMode: 'test',
      paymentId: paid.paymentId,
      subscriptionId: paid.subscriptionId,
      refundId: null,
      originalDocumentId: null,
      totalMinor: 99_900,
      taxableMinor: 84_661,
      cgstMinor: 7619,
      sgstMinor: 7620,
      igstMinor: 0,
      supply: 'intra',
      placeOfSupply: '29',
      buyerGstin: INTRA_GSTIN,
      noTaxReduction: false,
      reason: null,
      createdBy: null,
    })
    expect(document.issuedAt.toISOString()).toBe(ISSUED_AT.toISOString())
    expect(document.snapshot).toStrictEqual({
      version: 1,
      seller: {
        legalName: FIXTURE_SELLER.legalName,
        addressLines: FIXTURE_SELLER.addressLines,
        gstin: '29AABCE1234F1Z1',
        state: { code: '29', name: 'Karnataka' },
      },
      buyer: {
        legalName: 'Acme Studio Pvt Ltd',
        gstin: INTRA_GSTIN,
        addressLines: ['4 Park Street', 'Pune 411001'],
        state: { code: '29', name: 'Karnataka' },
        source: 'tax_details',
      },
      placeOfSupply: { code: '29', name: 'Karnataka' },
      supply: 'intra',
      sacCode: '998431',
      description: paid.description,
      billingPeriod: { start: '2026-10-26', end: '2026-11-26' },
      amounts: {
        totalMinor: 99_900,
        taxableMinor: 84_661,
        cgstMinor: 7619,
        sgstMinor: 7620,
        igstMinor: 0,
        ratePercent: 18,
      },
      reference: { paymentId: paid.paymentId, refundId: null },
      original: null,
      reason: null,
    })
    expect(await counter('invoice', '26-27')).toBe(1)
  })

  it('charges IGST to an inter-state buyer, supplied in its own state', async () => {
    const { tenant, owner } = await workspace()
    await saveDetails(tenant.id, owner.id, { gstin: INTER_GSTIN, stateCode: '27' })

    const document = await issued(tenant.id)

    expect(document).toMatchObject({
      taxableMinor: 84_661,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 15_239,
      supply: 'inter',
      placeOfSupply: '27',
    })
    expect(document.snapshot.placeOfSupply).toStrictEqual({ code: '27', name: 'Maharashtra' })
  })

  it('names a buyer with no tax details by the workspace, supplied in the seller state', async () => {
    const { tenant } = await workspace('Nameless Co')

    const document = await issued(tenant.id)

    expect(document.snapshot.buyer).toStrictEqual({
      legalName: 'Nameless Co',
      gstin: null,
      addressLines: [],
      state: null,
      source: 'workspace',
    })
    expect(document).toMatchObject({ placeOfSupply: '29', supply: 'intra', buyerGstin: null })
  })

  it('answers exists for a payment already invoiced and takes no number', async () => {
    const { tenant } = await workspace()
    const paid = charge()
    await issued(tenant.id, paid)

    const again = await issueInvoice(tenant.id, paid, scope, ISSUED_AT)

    expect(again).toStrictEqual({ outcome: 'exists' })
    expect(await counter('invoice', '26-27')).toBe(1)
  })

  it('holds an SEZ buyer charge with no document and no number', async () => {
    const { tenant, owner } = await workspace()
    await saveDetails(tenant.id, owner.id, { gstin: INTRA_GSTIN, stateCode: '29', isSez: true })
    const paid = charge()

    const result = await issueInvoice(tenant.id, paid, scope, ISSUED_AT)

    expect(result).toStrictEqual({ outcome: 'held' })
    const held = await taxRepository.findHeldByPayment(scope, paid.paymentId)
    expect(held).toMatchObject({
      tenantId: tenant.id,
      subscriptionId: paid.subscriptionId,
      amountMinor: 99_900,
      paidAt: paid.paidAt,
      resolvedAt: null,
    })
    expect(await taxRepository.hasDocuments(tenant.id)).toBe(false)
    expect(await counter('invoice', '26-27')).toBeUndefined()
    expect(await issueInvoice(tenant.id, paid, scope, ISSUED_AT)).toStrictEqual({
      outcome: 'exists',
    })
  })

  it('answers no_row for a workspace with no billing row', async () => {
    const result = await issueInvoice(randomUUID(), charge(), scope, ISSUED_AT)

    expect(result).toStrictEqual({ outcome: 'no_row' })
    expect(await counter('invoice', '26-27')).toBeUndefined()
  })

  it('keeps the stored snapshot when the tax details change after issue', async () => {
    const { tenant, owner } = await workspace()
    await saveDetails(tenant.id, owner.id, { gstin: INTRA_GSTIN, stateCode: '29' })
    const document = await issued(tenant.id)

    await withTransaction((tx) =>
      taxRepository.updateDetailsVersioned(
        tenant.id,
        1,
        { gstin: INTER_GSTIN, stateCode: '27', legalName: 'Renamed Pvt Ltd' },
        owner.id,
        tx
      )
    )
    await sql`update tenants set name = 'Renamed' where id = ${tenant.id}`

    const stored = await taxRepository.findDocument(tenant.id, document.id)
    expect(stored?.snapshot).toStrictEqual(document.snapshot)
    expect(stored?.snapshot.buyer.gstin).toBe(INTRA_GSTIN)
  })

  it('records a system audit entry on the tax document', async () => {
    const { tenant } = await workspace()

    const document = await issued(tenant.id)

    expect(await auditRows(tenant.id)).toStrictEqual([
      {
        action: 'billing.tax_document_issued',
        target_type: 'tax_document',
        target_id: document.id,
        access: 'system',
        actor_kind: 'system',
        actor_user_id: null,
        metadata: { type: 'invoice' },
      },
    ])
  })
})

describe('issueCreditNote', () => {
  it('issues credit notes that add up to the invoice, then refuses more', async () => {
    const { tenant, owner } = await workspace()
    await saveDetails(tenant.id, owner.id, { gstin: INTRA_GSTIN, stateCode: '29' })
    const invoice = await issued(tenant.id)

    const first = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 50_000, refundId: 'rfnd_A1', reason: 'Refund' },
      ISSUED_AT
    )
    const second = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 49_900, refundId: 'rfnd_A2', reason: 'Refund' },
      ISSUED_AT
    )
    const third = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 1, refundId: 'rfnd_A3', reason: 'Refund' },
      ISSUED_AT
    )

    if (first.outcome !== 'issued' || second.outcome !== 'issued') throw new Error('not issued')
    expect(first.document).toMatchObject({
      type: 'credit_note',
      number: 'CN/26-27/00001',
      financialYear: '26-27',
      tenantId: tenant.id,
      originalDocumentId: invoice.id,
      paymentId: invoice.paymentId,
      subscriptionId: invoice.subscriptionId,
      refundId: 'rfnd_A1',
      totalMinor: 50_000,
      taxableMinor: 42_373,
      cgstMinor: 3813,
      sgstMinor: 3814,
      igstMinor: 0,
      supply: 'intra',
      placeOfSupply: '29',
      buyerGstin: INTRA_GSTIN,
      noTaxReduction: false,
      reason: 'Refund',
      createdBy: null,
    })
    expect(first.document.snapshot).toMatchObject({
      seller: invoice.snapshot.seller,
      buyer: invoice.snapshot.buyer,
      placeOfSupply: invoice.snapshot.placeOfSupply,
      supply: 'intra',
      reference: { paymentId: invoice.paymentId, refundId: 'rfnd_A1' },
      original: { number: 'INV/26-27/00001', issuedAt: invoice.issuedAt.toISOString() },
      reason: 'Refund',
    })
    expect(second.document).toMatchObject({ number: 'CN/26-27/00002', totalMinor: 49_900 })
    const notes = [first.document, second.document]
    for (const field of [
      'totalMinor',
      'taxableMinor',
      'cgstMinor',
      'sgstMinor',
      'igstMinor',
    ] as const) {
      expect(notes.reduce((sum, note) => sum + note[field], 0)).toBe(invoice[field])
    }
    expect(third).toStrictEqual({ outcome: 'over_credit', remainingMinor: 0 })
    expect(await counter('credit_note', '26-27')).toBe(2)
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses a credit of %s paise before it locks or writes anything',
    async (amountMinor) => {
      const { tenant } = await workspace()
      const invoice = await issued(tenant.id)

      await expect(
        issueCreditNote(
          tenant.id,
          invoice.id,
          { amountMinor, refundId: 'rfnd_Z1', reason: 'Refund' },
          ISSUED_AT
        )
      ).rejects.toBeInstanceOf(RangeError)
      expect(await counter('credit_note', '26-27')).toBeUndefined()
    }
  )

  it('answers exists for a refund already credited', async () => {
    const { tenant } = await workspace()
    const invoice = await issued(tenant.id)
    const credit = { amountMinor: 30_000, refundId: 'rfnd_B1', reason: 'Refund' }
    await issueCreditNote(tenant.id, invoice.id, credit, ISSUED_AT)

    const again = await issueCreditNote(tenant.id, invoice.id, credit, ISSUED_AT)

    expect(again).toStrictEqual({ outcome: 'exists', remainingMinor: 69_900 })
    expect(await counter('credit_note', '26-27')).toBe(1)
  })

  it('gives no tax reduction for a note dated 1 December after the invoice year ends', async () => {
    const { tenant } = await workspace()
    const invoice = await issued(tenant.id)

    const late = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 10_000, refundId: 'rfnd_C1', reason: 'Refund' },
      new Date('2027-12-01T00:00:00+05:30')
    )

    expect(late).toMatchObject({
      outcome: 'issued',
      document: { number: 'CN/27-28/00001', financialYear: '27-28', noTaxReduction: true },
    })
  })

  it('gives the tax reduction for a note dated 30 November after the invoice year ends', async () => {
    const { tenant } = await workspace()
    const invoice = await issued(tenant.id)

    const onTime = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 10_000, refundId: 'rfnd_C2', reason: 'Refund' },
      new Date('2027-11-30T23:59:59+05:30')
    )

    expect(onTime).toMatchObject({ outcome: 'issued', document: { noTaxReduction: false } })
  })

  it('records a system audit entry for an automatic note', async () => {
    const { tenant } = await workspace()
    const invoice = await issued(tenant.id)

    const note = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 10_000, refundId: 'rfnd_D1', reason: 'Refund' },
      ISSUED_AT
    )

    if (note.outcome !== 'issued') throw new Error('not issued')
    const rows = await auditRows(tenant.id)
    expect(rows.at(-1)).toStrictEqual({
      action: 'billing.tax_document_issued',
      target_type: 'tax_document',
      target_id: note.document.id,
      access: 'system',
      actor_kind: 'system',
      actor_user_id: null,
      metadata: { type: 'credit_note' },
    })
  })

  it('treats another workspace invoice as not found and takes no number', async () => {
    const { tenant } = await workspace()
    const { tenant: other } = await workspace('Other Co')
    const foreign = await issued(other.id)

    const result = await issueCreditNote(
      tenant.id,
      foreign.id,
      { amountMinor: 10_000, refundId: 'rfnd_E1', reason: 'Refund' },
      ISSUED_AT
    )

    expect(result).toStrictEqual({ outcome: 'no_row' })
    expect(await counter('credit_note', '26-27')).toBeUndefined()
  })

  it('treats another workspace credit note as not found, not as a credit note', async () => {
    const { tenant } = await workspace()
    const { tenant: other } = await workspace('Other Co')
    const foreign = await issued(other.id)
    const note = await issueCreditNote(
      other.id,
      foreign.id,
      { amountMinor: 10_000, refundId: 'rfnd_E2', reason: 'Refund' },
      ISSUED_AT
    )
    if (note.outcome !== 'issued') throw new Error('not issued')

    const result = await issueCreditNote(
      tenant.id,
      note.document.id,
      { amountMinor: 1, refundId: 'rfnd_E3', reason: 'Refund' },
      ISSUED_AT
    )

    expect(result).toStrictEqual({ outcome: 'no_row' })
  })

  it('answers no_row for an unknown document', async () => {
    const { tenant } = await workspace()

    const result = await issueCreditNote(
      tenant.id,
      randomUUID(),
      { amountMinor: 1, refundId: 'rfnd_E4', reason: 'Refund' },
      ISSUED_AT
    )

    expect(result).toStrictEqual({ outcome: 'no_row' })
  })

  it('answers not_an_invoice for the workspace own credit note', async () => {
    const { tenant } = await workspace()
    const invoice = await issued(tenant.id)
    const note = await issueCreditNote(
      tenant.id,
      invoice.id,
      { amountMinor: 10_000, refundId: 'rfnd_F1', reason: 'Refund' },
      ISSUED_AT
    )
    if (note.outcome !== 'issued') throw new Error('not issued')

    const result = await issueCreditNote(
      tenant.id,
      note.document.id,
      { amountMinor: 1, refundId: 'rfnd_F2', reason: 'Refund' },
      ISSUED_AT
    )

    expect(result).toStrictEqual({ outcome: 'not_an_invoice' })
    expect(await counter('credit_note', '26-27')).toBe(1)
  })

  describe('by staff', () => {
    it('records the admin as creator and audits it as a platform action only', async () => {
      const { tenant } = await workspace()
      const invoice = await issued(tenant.id)
      const { user: admin } = await createTrackedStaff('admin')

      const result = await issueCreditNote(
        tenant.id,
        invoice.id,
        { amountMinor: 20_000, refundId: null, reason: 'Goodwill credit, ticket 42' },
        ISSUED_AT,
        { staff: { actor: { userId: admin.id } } }
      )

      if (result.outcome !== 'issued') throw new Error('not issued')
      expect(result.document).toMatchObject({
        createdBy: admin.id,
        refundId: null,
        paymentId: null,
        reason: 'Goodwill credit, ticket 42',
      })
      expect(result.document.snapshot.reference).toStrictEqual({
        paymentId: invoice.paymentId,
        refundId: null,
      })
      const rows = await auditRows(tenant.id)
      expect(rows.map((row) => row.action)).toStrictEqual([
        'billing.tax_document_issued',
        'billing.credit_note_issued_by_staff',
      ])
      expect(rows[1]).toStrictEqual({
        action: 'billing.credit_note_issued_by_staff',
        target_type: 'tax_document',
        target_id: result.document.id,
        access: 'platform',
        actor_kind: 'user',
        actor_user_id: admin.id,
        metadata: { invoiceId: invoice.id, reason: 'Goodwill credit, ticket 42' },
      })
    })

    it('refuses an actor demoted to manager and writes nothing', async () => {
      const { tenant } = await workspace()
      const invoice = await issued(tenant.id)
      const { user: demoted } = await createTrackedStaff('admin')
      const platform = await platformTenant()
      await sql`
        update user_memberships set role = 'manager'
        where user_id = ${demoted.id} and tenant_id = ${platform.id}
      `

      const refusal = issueCreditNote(
        tenant.id,
        invoice.id,
        { amountMinor: 20_000, refundId: null, reason: 'Goodwill credit' },
        ISSUED_AT,
        { staff: { actor: { userId: demoted.id } } }
      )

      await expect(refusal).rejects.toBeInstanceOf(HttpError)
      await expect(refusal).rejects.toMatchObject({ statusCode: 404 })
      expect(await counter('credit_note', '26-27')).toBeUndefined()
      const rows = await auditRows(tenant.id)
      expect(rows.map((row) => row.action)).toStrictEqual(['billing.tax_document_issued'])
    })
  })
})

describe('buildSnapshot', () => {
  it('prints the buyer from the tax details, skipping empty address parts', () => {
    const snapshot = buildSnapshot({
      seller: FIXTURE_SELLER,
      details: {
        tenantId: 't1',
        gstin: null,
        legalName: 'Solo Trader',
        addressLine1: null,
        addressLine2: null,
        city: 'Mysuru',
        pincode: null,
        stateCode: '29',
        isSez: false,
        updatedBy: null,
        updatedAt: new Date(),
        version: 1,
      },
      tenantName: 'Ignored',
      description: 'Paid, Yearly',
      billingPeriod: null,
      amounts: {
        totalMinor: 118,
        taxableMinor: 100,
        cgstMinor: 9,
        sgstMinor: 9,
        igstMinor: 0,
        ratePercent: 18,
      },
      supply: 'intra',
      placeOfSupply: { code: '29', name: 'Karnataka' },
      reference: { paymentId: 'pay_1', refundId: null },
      original: null,
      reason: null,
    })

    expect(snapshot.buyer).toStrictEqual({
      legalName: 'Solo Trader',
      gstin: null,
      addressLines: ['Mysuru'],
      state: { code: '29', name: 'Karnataka' },
      source: 'tax_details',
    })
    expect(snapshot.billingPeriod).toBeNull()
  })
})
