// tests/integration/repositories/email-log-error-code-shape-mutation.test.ts
//
// Round-2 review finding 1: no existing test exercised
// `withErrorCodeNormalized`'s shape clause (`ERROR_CODE_PATTERN.test(...)`)
// through `record()` itself — the 64-character raw-token test short-circuits
// on the LENGTH check alone, and the DB-level CHECK tests bypass the
// repository entirely. Deleting `&& ERROR_CODE_PATTERN.test(...)` from the
// guard left the whole suite green while a width-fitting, wrong-shaped value
// (the realistic case: a 32-character lowercase-hex fragment of a raw token)
// would reach the database and throw — reintroducing, at the repository
// layer, precisely the defect the round-1 fix closed. This file proves the
// new test (`email-log.repository.test.ts`, "normalizes a
// wrong-shaped-but-within-width error code...") is load-bearing against that
// exact regression.
//
// `withErrorCodeNormalized` itself is a plain module-scope function, not a
// method on a shared prototype — `record()` calls it directly, by value,
// within the same module, so `withMutatedModule` (which intercepts import
// resolution) cannot reach it either: nothing outside this file ever imports
// `withErrorCodeNormalized` to begin with. `record()` IS a method on
// `EmailLogRepository.prototype`, and uses no `this`, so the addressable
// surface for `withMutatedMethod` is `record` itself: this file swaps in a
// full replacement that inlines the exact regression (the length check,
// with the shape check deleted) and drives the real `emailLogRepository`
// through it.
//
// Two tests, same shape as every other mutation-proof file in this repo
// (see token-reuse-mutation.test.ts's own header comment):
//
//   1. Always on: mutated -> a width-fitting, wrong-shaped errorCode reaches
//      the database and the insert REJECTS (the CHECK constraint fires,
//      Ruling E is violated: a log write fails for an email that already
//      sent). Restored -> a fresh call with the identical input succeeds
//      and normalizes to UNKNOWN_ERROR_CODE.
//
//   2. `it.runIf(process.env.MUTATION_PROOF === '1')`, DELIBERATELY red
//      under that flag: reproduces the real new test's own assertion
//      (`expect(recorded.errorCode).toBe(UNKNOWN_ERROR_CODE)`) against the
//      mutated implementation — which rejects before that assertion is ever
//      reached, so the test fails via the unhandled rejection itself.
//
//        MUTATION_PROOF=1 pnpm exec vitest run tests/integration/repositories/email-log-error-code-shape-mutation.test.ts   # red
//        pnpm exec vitest run tests/integration/repositories/email-log-error-code-shape-mutation.test.ts                    # green
//
//      No file changes between the two runs — only the environment variable
//      differs — and `git status --porcelain` stays empty throughout
//      (tests/helpers/mutate.ts).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emailLogModel,
  ERROR_CODE_MAX_LENGTH,
  type EmailLog,
  type NewEmailLog,
} from '@/database/models/email-log.model'
import { HttpError } from '@/errors/http-error'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { db, sql } from '@/services/database.service'
import { withMutatedMethod } from '../../helpers/mutate'

const emailLogRepository = new EmailLogRepository()

/**
 * A disposable recipient address, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueRecipient(): string {
  return `email-log-shape-mutation-${randomUUID()}@example.test`
}

/**
 * `record()`'s exact pre-fix regression: the LENGTH half of
 * `withErrorCodeNormalized`'s guard, with the shape half
 * (`ERROR_CODE_PATTERN.test(...)`) deleted. A width-fitting but
 * wrong-shaped `errorCode` now looks "valid" to this guard and reaches the
 * insert unchanged, where `email_logs_error_code_check` (email-log.model.ts)
 * rejects it.
 * @param entry - The row to insert.
 * @returns The inserted row.
 */
async function recordWithLengthOnlyGuard(entry: NewEmailLog): Promise<EmailLog> {
  const isValid =
    typeof entry.errorCode !== 'string' || entry.errorCode.length <= ERROR_CODE_MAX_LENGTH
  const values = isValid ? entry : { ...entry, errorCode: 'UNKNOWN' }
  const [row] = await db.insert(emailLogModel).values(values).returning()
  if (row === undefined) throw new HttpError('Insert returned no row', 500)
  return row
}

describe('mutation-test harness, proven on withErrorCodeNormalized’s shape clause', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from email_logs where id = any(${createdIds})`
    createdIds.length = 0
  })

  it('a length-only guard lets a wrong-shaped error code reach the database and reject; the real guard normalizes it instead', async () => {
    const wrongShaped = 'a1'.repeat(16) // 32 lowercase-hex characters — fits the width exactly

    // MUTATED: record() checks length only. The database's own CHECK
    // constraint is what actually fires here — record() no longer stops
    // this value before the insert, so the insert itself throws. This IS
    // the Ruling E violation the shape clause exists to prevent: a log
    // write failing for an email that already sent.
    await withMutatedMethod(
      EmailLogRepository.prototype,
      'record',
      recordWithLengthOnlyGuard,
      async () => {
        await expect(
          emailLogRepository.record({
            recipient: uniqueRecipient(),
            templateKey: 'password_reset',
            status: 'failed',
            errorCode: wrongShaped,
          })
        ).rejects.toThrow()
      }
    )

    // RESTORED: a fresh call with the identical wrong-shaped input, same
    // sequence, proves the real guard is back and handles it correctly.
    const recorded = await emailLogRepository.record({
      recipient: uniqueRecipient(),
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: wrongShaped,
    })
    createdIds.push(recorded.id)
    expect(recorded.errorCode).toBe('UNKNOWN')
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — see this file's
  // header comment. Left unset, this test is skipped and the file is
  // green.
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "normalizes a wrong-shaped-but-within-width error code" test’s own assertion against the length-only mutation',
    async () => {
      const wrongShaped = 'a1'.repeat(16)

      await withMutatedMethod(
        EmailLogRepository.prototype,
        'record',
        recordWithLengthOnlyGuard,
        async () => {
          const recorded = await emailLogRepository.record({
            recipient: uniqueRecipient(),
            templateKey: 'password_reset',
            status: 'failed',
            errorCode: wrongShaped,
          })
          createdIds.push(recorded.id)
          // The real test's own assertion, reproduced against the mutated,
          // length-only implementation — this is what goes red (via the
          // insert's own rejection, before this line is ever reached), not a
          // hand-written stand-in for it.
          expect(recorded.errorCode).toBe('UNKNOWN')
        }
      )
    }
  )
})
