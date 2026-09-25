// tests/unit/middlewares/rate-limit-mutation.test.ts
//
// Fix round 1 on B3 Task 0: withMutatedMethod was proven against a real
// security behaviour (reuse detection); withMutatedModule was proven only
// against a pure fixture pair. That asymmetry is exactly the pattern this
// project keeps finding — a mechanism that works on a toy and has never
// been fired at the thing it exists for. This file fires it at
// loginRateLimitKey (src/middlewares/rate-limit.middleware.ts): the exact
// mutation a background scanner caught by hand during B2, reducing the
// composite `${ip}:${email}` key to IP alone.
//
// loginRateLimitKey is PRIVATE to rate-limit.middleware.ts — never
// exported, used only inside createLoginRateLimiter()'s own call to
// `rateLimit({ ..., keyGenerator: loginRateLimitKey })` — so there is no
// exported binding withMutatedModule could replace directly; it mutates a
// SUBJECT's DEPENDENCY, and a private same-file function is not reachable
// through any import edge. What IS a genuine dependency edge is `rateLimit`
// itself, imported from the third-party `express-rate-limit` package
// (rate-limit.middleware.ts's own import line). Wrapping it to force
// `keyGenerator` to an IP-only function — whatever createLoginRateLimiter
// actually passed — reproduces the identical observable bug: the composite
// key collapses to IP alone. Every other limiter in this file is
// unaffected: none of the other three pass their own `keyGenerator`, so
// they already fall back to express-rate-limit's own IP-based default.
//
// This IS proof the variant works against a module imported the way this
// one is (ESM, extensionless `@/` alias, a factory called at module
// scope): `loadSubject` is a literal `import('@/middlewares/rate-limit.middleware')`,
// and createLoginRateLimiter is called fresh, post-mutation, exactly as
// production code calls it.
//
// Same in-memory-store setup as the sibling rate-limit.middleware.test.ts:
// @/services/redis.service is mocked to always reject, so this stays
// Docker-independent and belongs under tests/unit/.
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
 * Build a bare app behind a login rate limiter built by the given factory —
 * real or, while a mutation is active, freshly-loaded-and-mutated.
 * @param createLoginRateLimiter - The factory to build the limiter from.
 * @returns The app.
 */
function buildApp(createLoginRateLimiter: typeof CreateRateLimiter): Express {
  const app = express()
  app.use(express.json())
  app.post(
    '/login',
    createLoginRateLimiter(RATE_LIMITS.login, { limit: 2, windowMs: 60_000 }),
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
 * @param createLoginRateLimiter - The factory to build the limiter from.
 * @returns The status code of the request from the different email.
 */
async function bystanderStatusAfterExhaustingVictim(
  createLoginRateLimiter: typeof CreateRateLimiter
): Promise<number> {
  const app = buildApp(createLoginRateLimiter)
  await attempt(app, 'victim@example.com')
  await attempt(app, 'victim@example.com')
  const victimBlocked = await attempt(app, 'victim@example.com')
  expect(victimBlocked.status).toBe(429)

  const bystander = await attempt(app, 'someone-else@example.com')
  return bystander.status
}

describe('withMutatedModule, proven on the login rate limiter’s real key generator', () => {
  it('forcing keyGenerator to IP-only reopens the lockout the composite key exists to prevent; restoring closes it again', async () => {
    // Captured via vi.importActual, bypassing any mock, BEFORE
    // withMutatedModule registers one — this is the real express-rate-limit,
    // used to build an override that still calls the real rateLimit()
    // underneath, with only `keyGenerator` forced.
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
        // MUTATED: with the key collapsed to IP-only, a bystander sharing
        // the victim's IP is blocked too — exactly the lockout the
        // composite key exists to prevent (rate-limit.middleware.test.ts's
        // "keys on IP AND email" test asserts the opposite: 401, not 429).
        const status = await bystanderStatusAfterExhaustingVictim(createRateLimiter)
        expect(status).toBe(429)
      }
    )

    // RESTORED: a fresh import gets the real loginRateLimitKey back.
    const { createRateLimiter } = await import('@/middlewares/rate-limit.middleware')
    const status = await bystanderStatusAfterExhaustingVictim(createRateLimiter)
    expect(status).toBe(401)
  })

  // DELIBERATELY red when run with MUTATION_PROOF=1 — reproduces the real
  // "keys on IP AND email" test's own assertion
  // (tests/unit/middlewares/rate-limit.middleware.test.ts) against the
  // mutated dependency, so the failure shown is the actual regression test
  // failing. Left unset (the default), skipped, and the file is green:
  //
  //   MUTATION_PROOF=1 pnpm exec vitest run tests/unit/middlewares/rate-limit-mutation.test.ts   # red
  //   pnpm exec vitest run tests/unit/middlewares/rate-limit-mutation.test.ts                    # green
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

          // A different email, same supertest agent — so the same client
          // IP — must be entirely unaffected by victim@example.com's
          // counter. With the guard mutated, it is not.
          const bystander = await attempt(app, 'someone-else@example.com')
          expect(bystander.status).toBe(401)
        }
      )
    }
  )
})
