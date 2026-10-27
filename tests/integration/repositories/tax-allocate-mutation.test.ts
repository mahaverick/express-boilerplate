/**
 * @file Proves the counter's row lock is what serialises allocators: with
 * the `FOR NO KEY UPDATE` read swapped for a plain one, two overlapping
 * allocations get the same number. Gated by MUTATION_PROOF=1; the mutation
 * lives in process memory only.
 */
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { taxDocumentCounterModel } from '@/database/models/tax.model'
import { TaxRepository } from '@/repositories/tax.repository'
import type { DbTransaction } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { allocateBehindLockHolder, resetTaxDocuments } from '../../helpers/tax'

const repository = new TaxRepository()

/**
 * The allocator without the lock on the counter read.
 */
async function allocateUnlocked(tx: DbTransaction): Promise<number> {
  const counter = taxDocumentCounterModel
  const where = and(eq(counter.type, 'invoice'), eq(counter.financialYear, '26-27'))
  await tx
    .insert(counter)
    .values({ type: 'invoice', financialYear: '26-27', lastNumber: 0 })
    .onConflictDoNothing()
  const [row] = await tx.select({ lastNumber: counter.lastNumber }).from(counter).where(where)
  const next = (row?.lastNumber ?? 0) + 1
  await tx.update(counter).set({ lastNumber: next }).where(where)
  return next
}

describe.skipIf(process.env['MUTATION_PROOF'] !== '1')('allocateNumber lock mutation', () => {
  beforeEach(resetTaxDocuments)
  afterEach(resetTaxDocuments)

  it('hands out the number the holder took without the row lock', async () => {
    await withMutatedMethod(
      repository,
      'allocateNumber',
      (_type, _year, tx) => allocateUnlocked(tx),
      async () => {
        const result = await allocateBehindLockHolder((tx) =>
          repository.allocateNumber('invoice', '26-27', tx)
        )
        expect(result.allocatedNumber).toBe(result.holderNumber)
      }
    )
  })
})
