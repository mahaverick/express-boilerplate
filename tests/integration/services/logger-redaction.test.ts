// tests/integration/services/logger-redaction.test.ts
//
// A real DrizzleQueryError, from a real unique-violation round trip against
// this worker's Postgres database — not tests/helpers/query-error.ts's
// fakeQueryError(), which every other leak-proof test in this repo uses
// against a mocked rejection. Inserted directly through db/userModel,
// bypassing UserRepository.create: that method's translatingUniqueViolation
// (base.repository.ts) catches a 23505 and rethrows a plain HttpError
// before a raw query error would ever reach a logger, so going through it
// here would prove nothing about serializeErrors.
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

afterEach(async () => {
  await sql`delete from users where lower(email) = lower(${LEAKED_EMAIL})`
})

describe('a real unique-violation query error never leaks its parameter', () => {
  it('is redacted whether logged directly or nested as a cause', async () => {
    await db.insert(userModel).values({ email: LEAKED_EMAIL })

    let queryError: unknown
    try {
      await db.insert(userModel).values({ email: LEAKED_EMAIL })
      expect.unreachable('second insert with the same email should have thrown')
    } catch (error) {
      queryError = error
    }
    expect(queryError).toBeInstanceOf(DrizzleQueryError)

    const { destination, output } = captureDestination()
    const log = createPinoLogger({ level: 'error', format: 'json', destination })

    log.error({ source: 'test.ts:1', error: queryError }, 'direct')
    log.error(
      { source: 'test.ts:1', error: new Error('wrapped', { cause: queryError }) },
      'wrapped'
    )

    await new Promise((resolve) => setImmediate(resolve))

    const text = output.join('\n')
    expect(text).not.toContain(LEAKED_EMAIL)
    expect(text).toContain('23505')
    expect(text).toContain('driverCode')
  })
})

describe('mutation proof: redactedForLog is what keeps the parameter out', () => {
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'leaks the parameter when redactedForLog is bypassed',
    async () => {
      await db.insert(userModel).values({ email: LEAKED_EMAIL })
      let queryError: unknown
      try {
        await db.insert(userModel).values({ email: LEAKED_EMAIL })
        expect.unreachable('second insert with the same email should have thrown')
      } catch (error) {
        queryError = error
      }

      await withMutatedModule(
        '@/errors/postgres-errors',
        { redactedForLog: (error: unknown) => error },
        () => import('@/services/logger.service'),
        async ({ createPinoLogger: mutatedCreatePinoLogger }) => {
          const { destination, output } = captureDestination()
          const log = mutatedCreatePinoLogger({ level: 'error', format: 'json', destination })

          log.error({ source: 'test.ts:1', error: queryError }, 'insert failed')
          await new Promise((resolve) => setImmediate(resolve))

          // Red without the redaction: a DrizzleQueryError's query/params
          // are enumerable (CLAUDE.md's own note on this), so passing the
          // raw error through unmodified puts the email back in the log.
          expect(output.join('\n')).toContain(LEAKED_EMAIL)
        }
      )
    }
  )
})
