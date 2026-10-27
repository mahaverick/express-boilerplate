/**
 * @file Clears the tax tables a test fills, in foreign-key order.
 */
import { randomUUID } from 'node:crypto'
import type { NewTaxDocument } from '@/database/models/tax.model'
import { sql } from '@/services/database.service'
import type { TaxDocumentSnapshot } from '@/types/tax'

/**
 * Empty the tax documents, their counters and the held charges in this
 * worker's database. Credit notes go first: `original_document_id` is
 * RESTRICT. Call it in `beforeEach` and `afterEach` of every tax test.
 * @returns Resolves once the tables are empty.
 */
export async function resetTaxDocuments(): Promise<void> {
  await sql`delete from tax_documents where type = 'credit_note'`
  await sql`delete from tax_documents`
  await sql`delete from tax_document_counters`
  await sql`delete from tax_held_charges`
}

/**
 * A valid new tax document row for a repository test, overridable per field.
 * @param tenantId - The workspace, or null for a purged one.
 * @param overrides - Columns to change.
 * @returns The row.
 */
export function taxDocumentRow(
  tenantId: string | null,
  overrides: Partial<NewTaxDocument> = {}
): NewTaxDocument {
  const snapshot: TaxDocumentSnapshot = {
    version: 1,
    seller: {
      legalName: 'Seller Pvt Ltd',
      addressLines: ['1 Road'],
      gstin: '29AABCE1234F1Z1',
      state: { code: '29', name: 'Karnataka' },
    },
    buyer: {
      legalName: 'Buyer',
      gstin: null,
      addressLines: [],
      state: null,
      source: 'workspace',
    },
    placeOfSupply: { code: '29', name: 'Karnataka' },
    supply: 'intra',
    sacCode: '998431',
    description: 'Software subscription',
    billingPeriod: null,
    amounts: {
      totalMinor: 11_800,
      taxableMinor: 10_000,
      cgstMinor: 900,
      sgstMinor: 900,
      igstMinor: 0,
      ratePercent: 18,
    },
    reference: { paymentId: null, refundId: null },
    original: null,
    reason: null,
  }
  return {
    type: 'invoice',
    number: `INV/26-27/${randomUUID().slice(0, 5)}`,
    financialYear: '26-27',
    issuedAt: new Date('2026-10-01T00:00:00.000Z'),
    tenantId,
    provider: 'razorpay',
    providerMode: 'test',
    paymentId: `pay_${randomUUID().slice(0, 12)}`,
    totalMinor: 11_800,
    taxableMinor: 10_000,
    cgstMinor: 900,
    sgstMinor: 900,
    igstMinor: 0,
    supply: 'intra',
    placeOfSupply: '29',
    snapshot,
    ...overrides,
  }
}
