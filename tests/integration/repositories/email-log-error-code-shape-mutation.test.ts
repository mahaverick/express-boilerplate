/**
 * @file `withErrorCodeNormalized`'s shape clause (`ERROR_CODE_PATTERN.test(...)`)
 * is exercised through `record()` only here — a 64-character raw token
 * short-circuits on the length check alone, and the DB-level CHECK tests
 * bypass the repository entirely, so deleting `&& ERROR_CODE_PATTERN.test(...)`
 * from the guard would leave the rest of the suite green while a
 * width-fitting, wrong-shaped value (a 32-character lowercase-hex fragment
 * of a raw token) reached the database and threw. `withErrorCodeNormalized`
 * is a plain module-scope function called by value within the same module,
 * so `withMutatedModule` cannot reach it; `record()`, which uses no `this`,
 * is swapped instead with a full replacement that inlines the length-only
 * regression and drives the real `emailLogRepository` through it. Two
 * tests, same shape as every other mutation-proof file in this repo (see
 * `token-reuse-mutation.test.ts`): an always-on test shows the mutated
 * guard lets a wrong-shaped value reach the database and reject, and the
 * restored guard normalizes it instead; a `MUTATION_PROOF` test reproduces
 * the real "normalizes a wrong-shaped-but-within-width error code"
 * assertion against the same mutation, deliberately red
 * (`MUTATION_PROOF=1 pnpm exec vitest run <this file>`; no file changes
 * between the two runs, per `tests/helpers/mutate.ts`).
 */
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
 * The regression this file guards against: the length half of
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

    // MUTATED: record() checks length only, so the database's own CHECK constraint is what fires here — a log write failing for an email that already sent, exactly what the shape clause exists to prevent.
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

    // RESTORED: a fresh call with the identical wrong-shaped input proves the real guard is back and handles it correctly.
    const recorded = await emailLogRepository.record({
      recipient: uniqueRecipient(),
      templateKey: 'password_reset',
      status: 'failed',
      errorCode: wrongShaped,
    })
    createdIds.push(recorded.id)
    expect(recorded.errorCode).toBe('UNKNOWN')
  })

  // Deliberately red under MUTATION_PROOF=1 (see this file's @file doc); left unset, this test is skipped and the file is green.
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
          // The real test's own assertion, reproduced against the mutated, length-only implementation — this goes red via the insert's own rejection, before this line is ever reached.
          expect(recorded.errorCode).toBe('UNKNOWN')
        }
      )
    }
  )
})
