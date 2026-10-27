/**
 * @file Proves the counter's row lock is what serialises number
 * allocators, against the real per-worker database. The mutation removes
 * only the `FOR NO KEY UPDATE` from `allocateNumber`'s counter read: the
 * real method runs on a transaction whose select builders ignore `.for()`,
 * so no copy of its body can drift from the code.
 *
 * Two tests:
 *
 * 1. Always on: with the lock removed, an allocation behind a lock holder
 *    hands out the holder's number again; with the method restored, the same
 *    overlap numbers after the holder. `pnpm test` and CI run it green.
 *
 * 2. `it.runIf(process.env.MUTATION_PROOF === '1')`, deliberately red under
 *    that flag: it repeats the assertion of "waits at the counter row lock and
 *    numbers after the holder" (`tax.repository.test.ts`) against the
 *    mutated method, so the failure shown is that regression test failing.
 *
 *    ```
 *    MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/tax-allocate-mutation.test.ts   # red
 *    pnpm exec vitest run tests/integration/repositories/tax-allocate-mutation.test.ts                    # green
 *    ```
 *
 *    Only the environment variable changes between the runs; the mutation
 *    lives in process memory, so `git status --porcelain` stays empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { TaxRepository } from '@/repositories/tax.repository'
import type { DbTransaction } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { allocateBehindLockHolder, resetTaxDocuments } from '../../helpers/tax'

const repository = new TaxRepository()
const realAllocateNumber = TaxRepository.prototype.allocateNumber

/**
 * Wrap a query builder so its `.for()` takes no row lock, following every
 * builder it returns.
 * @param query - The builder.
 * @returns The same builder, minus row locks.
 */
function withoutRowLock<T extends object>(query: T): T {
  return new Proxy(query, {
    get(target, key) {
      if (key === 'for') return () => withoutRowLock(target)
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      return (...arguments_: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, arguments_)
        return typeof result === 'object' && result !== null && 'where' in result
          ? withoutRowLock(result)
          : result
      }
    },
  })
}

/**
 * A transaction whose selects take no row lock; every other call passes
 * through.
 * @param tx - The real transaction.
 * @returns The wrapped transaction.
 */
function withoutRowLocks(tx: DbTransaction): DbTransaction {
  return new Proxy(tx, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'select') {
        return (...arguments_: unknown[]) =>
          withoutRowLock(Reflect.apply(value, target, arguments_) as object)
      }
      return value.bind(target) as unknown
    },
  })
}

/**
 * `allocateNumber` with the counter read's row lock removed.
 * @param this - The repository.
 * @param arguments_ - The real arguments.
 * @returns The number the real method hands out on the unlocked transaction.
 */
function allocateUnlocked(
  this: TaxRepository,
  ...arguments_: Parameters<TaxRepository['allocateNumber']>
): Promise<number> {
  const [type, financialYear, tx] = arguments_
  return Reflect.apply(realAllocateNumber, this, [type, financialYear, withoutRowLocks(tx)])
}

/**
 * Overlap one allocation with a holder of the counter row lock.
 * @returns What the helper saw.
 */
function overlap() {
  return allocateBehindLockHolder((tx) => repository.allocateNumber('invoice', '26-27', tx))
}

describe('allocateNumber lock mutation', () => {
  beforeEach(resetTaxDocuments)
  afterEach(resetTaxDocuments)

  it('hands out the holder number without the row lock, and numbers after it once restored', async () => {
    await withMutatedMethod(
      TaxRepository.prototype,
      'allocateNumber',
      allocateUnlocked,
      async () => {
        const mutated = await overlap()
        expect(mutated.allocatedNumber).toBe(mutated.holderNumber)
      }
    )

    await resetTaxDocuments()
    const restored = await overlap()
    expect(restored.allocatedNumber).toBe(restored.holderNumber + 1)
  })

  /**
   * Deliberately red under `MUTATION_PROOF=1` (see the file comment); skipped otherwise.
   */
  it.runIf(process.env['MUTATION_PROOF'] === '1')(
    'repeats the real lock test assertion against the mutated method',
    async () => {
      await withMutatedMethod(
        TaxRepository.prototype,
        'allocateNumber',
        allocateUnlocked,
        async () => {
          expect(await overlap()).toStrictEqual({
            queued: true,
            holderNumber: 2,
            allocatedNumber: 3,
          })
        }
      )
    }
  )
})
