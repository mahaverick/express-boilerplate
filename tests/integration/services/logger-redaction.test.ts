// tests/integration/services/logger-redaction.test.ts
//
// A real DrizzleQueryError, from a real unique-violation round trip against
// this worker's Postgres database — not tests/helpers/query-error.ts's
// fakeQueryError(), which stands in for one against a mocked rejection.
// Inserted directly through db/userModel, bypassing UserRepository.create:
// that method's translatingUniqueViolation (base.repository.ts) catches a
// 23505 and rethrows a plain HttpError before a raw query error would ever
// reach a logger, so going through it here would prove nothing about
// serializeErrors.
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { DrizzleQueryError } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { userModel } from '@/database/models/user.model'
import { db, sql } from '@/services/database.service'
import { createPinoLogger } from '@/services/logger.service'
import { withMutatedModule } from '../../helpers/mutate'

const LEAKED_EMAIL = `leak-${randomUUID()}@example.test`

/**
 * A real Writable that records each JSON line, same pattern
 * tests/unit/services/logger.service.test.ts uses.
 * @returns The capture stream and the lines it collects.
 */
function captureDestination(): { destination: Writable; output: string[] } {
  const output: string[] = []
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) output.push(line.trim())
      }
      callback()
    },
  })
  return { destination, output }
}

/**
 * Insert the same email twice, directly through db/userModel, to get a real
 * DrizzleQueryError from a live unique-violation round trip.
 * @returns The error thrown by the second insert.
 */
async function realUniqueViolation(): Promise<unknown> {
  await db.insert(userModel).values({ email: LEAKED_EMAIL })
  try {
    await db.insert(userModel).values({ email: LEAKED_EMAIL })
    expect.unreachable('second insert with the same email should have thrown')
  } catch (error) {
    return error
  }
}

afterEach(async () => {
  await sql`delete from users where lower(email) = lower(${LEAKED_EMAIL})`
})

describe('a real unique-violation query error never leaks its parameter', () => {
  it('is redacted whether logged directly or nested as a cause', async () => {
    const queryError = await realUniqueViolation()
    expect(queryError).toBeInstanceOf(DrizzleQueryError)

    const { destination, output } = captureDestination()
    const log = createPinoLogger({ level: 'error', format: 'json', destination })

    log.error({ source: 'test.ts:1', error: queryError }, 'direct')
    log.error(
      { source: 'test.ts:1', error: new Error('wrapped', { cause: queryError }) },
      'wrapped'
    )

    await new Promise((resolve) => setImmediate(resolve))
    expect(output).toHaveLength(2)

    const direct = JSON.parse(output[0] ?? '{}') as {
      error: { driverCode?: unknown; query?: unknown }
    }
    expect(JSON.stringify(direct)).not.toContain(LEAKED_EMAIL)
    expect(direct.error.driverCode).toBe('23505')
    expect(typeof direct.error.query).toBe('string')

    const wrapped = JSON.parse(output[1] ?? '{}') as {
      error: { cause?: { driverCode?: unknown; query?: unknown } }
    }
    expect(JSON.stringify(wrapped)).not.toContain(LEAKED_EMAIL)
    expect(wrapped.error.cause?.driverCode).toBe('23505')
    expect(typeof wrapped.error.cause?.query).toBe('string')
  })
})

// DELIBERATELY red under MUTATION_PROOF=1: each twin below reproduces one of
// the real test's own per-record assertions above, against the same real
// DrizzleQueryError, with redactedForLog swapped for the identity function
// (tests/helpers/mutate.ts's withMutatedModule). A DrizzleQueryError's query
// and params are enumerable (CLAUDE.md's own note on this), so bypassing the
// redaction puts the email straight back into whichever record the mutation
// reaches. Left unset, both are skipped and the file is green.
//
//   MUTATION_PROOF=1 pnpm exec vitest run tests/integration/services/logger-redaction.test.ts   # red
//   pnpm exec vitest run tests/integration/services/logger-redaction.test.ts                     # green
//
// No file changes between the two runs; git status --porcelain stays empty.
describe('mutation proof: redactedForLog is what keeps the parameter out', () => {
  it.runIf(process.env.MUTATION_PROOF === '1')(
    "reproduces the direct record's own assertions against the mutated redactedForLog",
    async () => {
      const queryError = await realUniqueViolation()

      await withMutatedModule(
        '@/errors/postgres-errors',
        { redactedForLog: (error: unknown) => error },
        () => import('@/services/logger.service'),
        async ({ createPinoLogger: mutatedCreatePinoLogger }) => {
          const { destination, output } = captureDestination()
          const log = mutatedCreatePinoLogger({ level: 'error', format: 'json', destination })

          log.error({ source: 'test.ts:1', error: queryError }, 'direct')
          await new Promise((resolve) => setImmediate(resolve))

          const direct = JSON.parse(output[0] ?? '{}') as {
            error: { driverCode?: unknown; query?: unknown }
          }
          expect(JSON.stringify(direct)).not.toContain(LEAKED_EMAIL)
          expect(direct.error.driverCode).toBe('23505')
          expect(typeof direct.error.query).toBe('string')
        }
      )
    }
  )

  it.runIf(process.env.MUTATION_PROOF === '1')(
    "reproduces the wrapped record's own assertions against the mutated redactedForLog",
    async () => {
      const queryError = await realUniqueViolation()

      await withMutatedModule(
        '@/errors/postgres-errors',
        { redactedForLog: (error: unknown) => error },
        () => import('@/services/logger.service'),
        async ({ createPinoLogger: mutatedCreatePinoLogger }) => {
          const { destination, output } = captureDestination()
          const log = mutatedCreatePinoLogger({ level: 'error', format: 'json', destination })

          log.error(
            { source: 'test.ts:1', error: new Error('wrapped', { cause: queryError }) },
            'wrapped'
          )
          await new Promise((resolve) => setImmediate(resolve))

          const wrapped = JSON.parse(output[0] ?? '{}') as {
            error: { cause?: { driverCode?: unknown; query?: unknown } }
          }
          expect(JSON.stringify(wrapped)).not.toContain(LEAKED_EMAIL)
          expect(wrapped.error.cause?.driverCode).toBe('23505')
          expect(typeof wrapped.error.cause?.query).toBe('string')
        }
      )
    }
  )
})
