/**
 * @file Clears the tax tables a test fills, in foreign-key order.
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { taxDocumentCounterModel, type NewTaxDocument } from '@/database/models/tax.model'
import { sql, withTransaction, type DbTransaction } from '@/services/database.service'
import type { TaxDocumentSnapshot } from '@/types/tax'
import { backendPid, deferred, waitForWaiter } from './lock-probe'

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

/**
 * Overlaps an allocation with a holder of the invoice series' counter row
 * lock. A committed allocation first makes the row exist. The holder locks
 * the row with `FOR NO KEY UPDATE`, the allocation starts and queues, then
 * the holder takes the next number by hand and commits. The conflict-check
 * insert does not wait on a row that is only locked, so the allocation can
 * only wait at its own locking read; an allocator that skips the lock reads
 * the old count and hands out the holder's number again.
 * @param allocate - Takes the next number of the invoice series for 26-27 in a transaction.
 * @returns Whether the allocation was seen queued behind the holder, the number the holder took and the number the allocation got.
 */
export async function allocateBehindLockHolder(
  allocate: (tx: DbTransaction) => Promise<number>
): Promise<{ queued: boolean; holderNumber: number; allocatedNumber: number }> {
  const seeded = await withTransaction(allocate)
  const locked = deferred()
  const release = deferred()
  let holderPid = 0
  const holder = withTransaction(async (tx) => {
    holderPid = await backendPid(tx)
    await tx
      .select()
      .from(taxDocumentCounterModel)
      .where(
        and(
          eq(taxDocumentCounterModel.type, 'invoice'),
          eq(taxDocumentCounterModel.financialYear, '26-27')
        )
      )
      .for('no key update')
    locked.resolve()
    await release.promise
    const holderNumber = seeded + 1
    await tx
      .update(taxDocumentCounterModel)
      .set({ lastNumber: holderNumber })
      .where(
        and(
          eq(taxDocumentCounterModel.type, 'invoice'),
          eq(taxDocumentCounterModel.financialYear, '26-27')
        )
      )
    return holderNumber
  })
  await locked.promise
  const allocation = withTransaction(allocate)
  const queued = await waitForWaiter(holderPid, allocation)
  release.resolve()
  const [holderNumber, allocatedNumber] = await Promise.all([holder, allocation])
  return { queued, holderNumber, allocatedNumber }
}
