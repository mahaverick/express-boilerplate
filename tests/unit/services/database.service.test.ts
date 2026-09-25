// tests/unit/services/database.service.test.ts
//
// withTransaction's branch logic (reuse vs. open) needs no real Postgres —
// proven here by mutating db.transaction itself, via
// tests/helpers/mutate.ts, rather than letting it actually connect. The
// deeper claim — that a nested reuse and a fresh open both really commit
// and roll back atomically — needs a real transaction and lives in
// tests/integration/services/database-transactions.test.ts instead.
import { PgTransaction } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { db, withTransaction, type DbTransaction } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'

describe('withTransaction', () => {
  it('reuses an already-open transaction: calls fn directly, without opening a new one', async () => {
    // withTransaction discriminates its executor with `instanceof
    // PgTransaction` (see database.service.ts), so a bare `{}` cast would
    // never take the reuse branch — it would silently fall through to
    // db.transaction instead, and this test would be asserting nothing.
    // Object.create(PgTransaction.prototype) is a real instance of that
    // class (no constructor call, so no real connection), which the
    // discriminator accepts while still being reference-distinct from
    // anything db.transaction produces.
    const fakeTx = Object.create(PgTransaction.prototype) as DbTransaction

    await withMutatedMethod(
      db,
      'transaction',
      () => {
        throw new Error('must not open a new transaction when one was already given')
      },
      async () => {
        const received: DbTransaction[] = []
        const result = await withTransaction((tx) => {
          received.push(tx)
          return Promise.resolve('ok')
        }, fakeTx)
        expect(result).toBe('ok')
        expect(received).toEqual([fakeTx])
      }
    )
  })

  it('opens a new transaction via db.transaction when no executor is given', async () => {
    const fakeTx = {} as DbTransaction
    let calledWith: unknown

    await withMutatedMethod(
      db,
      'transaction',
      // `as typeof db.transaction`: drizzle's `transaction` is generic over
      // the callback's return type, the same shape this codebase already
      // casts around elsewhere (see auth.test.ts's own mutation proof).
      ((function_: (tx: DbTransaction) => Promise<unknown>) => {
        calledWith = function_
        return function_(fakeTx)
      }) as typeof db.transaction,
      async () => {
        const received: DbTransaction[] = []
        const result = await withTransaction((tx) => {
          received.push(tx)
          return Promise.resolve('ok')
        })
        expect(result).toBe('ok')
        expect(received).toEqual([fakeTx])
        expect(calledWith).toBeInstanceOf(Function)
      }
    )
  })

  it('opens a new transaction via db.transaction when executor is explicitly the pool', async () => {
    const fakeTx = {} as DbTransaction

    await withMutatedMethod(
      db,
      'transaction',
      // `as typeof db.transaction`: see the previous test's own comment.
      ((function_: (tx: DbTransaction) => Promise<unknown>) =>
        function_(fakeTx)) as typeof db.transaction,
      async () => {
        const received: DbTransaction[] = []
        await withTransaction((tx) => {
          received.push(tx)
          return Promise.resolve()
        }, db)
        expect(received).toEqual([fakeTx])
      }
    )
  })
})
