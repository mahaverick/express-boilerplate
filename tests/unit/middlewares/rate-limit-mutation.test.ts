/**
 * @file Fires withMutatedModule at loginRateLimitKey
 * (src/constants/rate-limit.constants.ts) to prove the harness works
 * against a real security behaviour, not only a pure fixture pair. Same
 * in-memory-store setup as the sibling rate-limit.middleware.test.ts:
 * @/services/redis.service is mocked to always reject, so this stays
 * Docker-independent.
 */
import express, { type Express } from 'express'
import type { Test } from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import type { createRateLimiter as CreateRateLimiter } from '@/middlewares/rate-limit.middleware'
import { withMutatedModule } from '../../helpers/mutate'
import { request } from '../../helpers/request'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

/**
 * Build a bare app behind a login rate limiter built by the given
 * `createRateLimiter` — real or, while a mutation is active,
 * freshly-loaded-and-mutated.
 * @param createRateLimiter - The `createRateLimiter` to build the limiter from.
 * @returns The app.
 */
function buildApp(createRateLimiter: typeof CreateRateLimiter): Express {
  const app = express()
  app.use(express.json())
  app.post(
    '/login',
    createRateLimiter(RATE_LIMITS.login, { limit: 2, windowMs: 60_000 }),
    (_request, response) => {
      response.status(401).json({ success: false, message: 'Invalid email or password' })
    }
  )
  app.use(errorHandler)
  return app
}

/**
 * POST a login attempt.
 * @param app - The app under test.
 * @param email - The email to submit.
 * @returns The supertest response.
 */
function attempt(app: Express, email: string): Test {
  return request(app).post('/login').send({ email, password: 'wrong-password' })
}

/**
 * Exhaust `victim@example.com`'s budget (limit 2), then probe whether a
 * different email sharing the same IP is also blocked.
 * @param createRateLimiter - The `createRateLimiter` to build the limiter from.
 * @returns The status code of the request from the different email.
 */
async function bystanderStatusAfterExhaustingVictim(
  createRateLimiter: typeof CreateRateLimiter
): Promise<number> {
  const app = buildApp(createRateLimiter)
  await attempt(app, 'victim@example.com')
  await attempt(app, 'victim@example.com')
  const victimBlocked = await attempt(app, 'victim@example.com')
  expect(victimBlocked.status).toBe(429)

  const bystander = await attempt(app, 'someone-else@example.com')
  return bystander.status
}

/**
 * loginRateLimitKey is private to rate-limit.constants.ts, reached only
 * through `RATE_LIMITS.login.keyBy`, so there is no exported binding to
 * replace directly — the mutated dependency is `rateLimit` itself,
 * imported from the third-party express-rate-limit package, wrapped to
 * force `keyGenerator` to an IP-only function and so reproduce the
 * exact bug the composite `${ip}:${email}` key exists to prevent.
 * Every other limiter built through `createRateLimiter` is unaffected,
 * since none of the other `RATE_LIMITS` entries pass their own
 * key-generating function.
 */
describe('withMutatedModule, proven on the login rate limiter’s real key generator', () => {
  it('forcing keyGenerator to IP-only reopens the lockout the composite key exists to prevent; restoring closes it again', async () => {
    // Captured via vi.importActual, bypassing any mock, before withMutatedModule registers one — this is the real express-rate-limit, used to build an override that still calls the real rateLimit() underneath, with only `keyGenerator` forced.
    const actual = await vi.importActual<typeof import('express-rate-limit')>('express-rate-limit')

    await withMutatedModule<
      typeof import('express-rate-limit'),
      typeof import('@/middlewares/rate-limit.middleware')
    >(
      'express-rate-limit',
      {
        rateLimit: (passedOptions) =>
          actual.rateLimit({
            ...passedOptions,
            keyGenerator: (incomingRequest) =>
              actual.ipKeyGenerator(incomingRequest.ip ?? 'unknown'),
          }),
      },
      () => import('@/middlewares/rate-limit.middleware'),
      async ({ createRateLimiter }) => {
        // Mutated: with the key collapsed to IP-only, a bystander sharing the victim's IP is blocked too — exactly the lockout the composite key exists to prevent (rate-limit.middleware.test.ts's "keys on IP AND email" test asserts the opposite: 401, not 429).
        const status = await bystanderStatusAfterExhaustingVictim(createRateLimiter)
        expect(status).toBe(429)
      }
    )

    // Restored: a fresh import gets the real loginRateLimitKey back.
    const { createRateLimiter } = await import('@/middlewares/rate-limit.middleware')
    const status = await bystanderStatusAfterExhaustingVictim(createRateLimiter)
    expect(status).toBe(401)
  })

  /**
   * Deliberately red when run with MUTATION_PROOF=1 — reproduces the real
   * "keys on IP AND email" test's own assertion
   * (tests/unit/middlewares/rate-limit.middleware.test.ts) against the
   * mutated dependency, so the failure shown is the actual regression
   * test failing. Left unset (the default), it is skipped and the file is
   * green:
   *
   *   MUTATION_PROOF=1 pnpm exec vitest run tests/unit/middlewares/rate-limit-mutation.test.ts   # red
   *   pnpm exec vitest run tests/unit/middlewares/rate-limit-mutation.test.ts                    # green
   */
  it.runIf(process.env.MUTATION_PROOF === '1')(
    'reproduces the real "keys on IP AND email" test’s own assertion against the mutated key generator',
    async () => {
      const actual =
        await vi.importActual<typeof import('express-rate-limit')>('express-rate-limit')

      await withMutatedModule<
        typeof import('express-rate-limit'),
        typeof import('@/middlewares/rate-limit.middleware')
      >(
        'express-rate-limit',
        {
          rateLimit: (passedOptions) =>
            actual.rateLimit({
              ...passedOptions,
              keyGenerator: (incomingRequest) =>
                actual.ipKeyGenerator(incomingRequest.ip ?? 'unknown'),
            }),
        },
        () => import('@/middlewares/rate-limit.middleware'),
        async ({ createRateLimiter }) => {
          const app = buildApp(createRateLimiter)

          await attempt(app, 'victim@example.com')
          await attempt(app, 'victim@example.com')
          const victimBlocked = await attempt(app, 'victim@example.com')
          expect(victimBlocked.status).toBe(429)

          // A different email, same supertest agent — so the same client IP — must be entirely unaffected by victim@example.com's counter. With the guard mutated, it is not.
          const bystander = await attempt(app, 'someone-else@example.com')
          expect(bystander.status).toBe(401)
        }
      )
    }
  )
})
