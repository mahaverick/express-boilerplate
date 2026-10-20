/**
 * @file The limiter's own logic, isolated from the database and from
 * real Redis: `@/services/redis.service` is mocked to always reject, so
 * `SharedRateLimitStore` stays on its in-memory fallback for the whole
 * file. A bare `express()` app stands in for `createApp()`: importing
 * `@/app` here would pull in `database.service.ts` at module scope for
 * no reason this file needs. The stub route below never checks
 * credentials; it exists only so a request has somewhere to land after
 * the limiter lets it through, so these tests prove the limiter's
 * behaviour, not a controller's. getEnv() is a vi.fn over the real
 * one, so the RATE_LIMIT_SCALE tests hand createRateLimiter their own APP_ENV
 * and scale.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type RequestHandler } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv, type Env } from '@/configs/env.config'
import {
  RATE_LIMITED_CODE,
  RATE_LIMITS,
  type RateLimiterSpec,
} from '@/constants/rate-limit.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { request } from '../../helpers/request'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

/**
 * A bare app behind an arbitrary limiter, answering 201 when the request
 * gets through. Used for the limiters that are NOT keyed on the request
 * body, where the stub's own status only has to be distinguishable from a
 * 429.
 */
function buildAppBehind(limiter: RequestHandler): Express {
  const app = express()
  app.use(express.json())
  app.post('/endpoint', limiter, (_request, response) => {
    response.status(201).json({ success: true })
  })
  app.use(errorHandler)
  return app
}

/**
 * A bare app behind an arbitrary limiter, the same as `buildAppBehind`
 * except a stub middleware runs FIRST and populates `request.user` from a
 * test-only `x-test-user-id` header, standing in for `requireAuth`, which
 * the real routes mount ahead of the user-keyed limiters. A header, not a
 * fixed id baked into the app, so one app instance (and therefore one
 * shared limiter/store) can simulate several different authenticated
 * callers across separate requests: the same "vary the identity per
 * request, not per app" shape.
 */
function buildAppBehindAsUser(limiter: RequestHandler): Express {
  const app = express()
  app.use(express.json())
  app.use((thisRequest, _response, next) => {
    const userId = thisRequest.get('x-test-user-id')
    if (userId) {
      thisRequest.user = {
        id: userId,
        email: 'stub@example.test',
        // eslint-disable-next-line unicorn/no-null -- AuthenticatedUser.firstName/lastName are `string | null`.
        firstName: null,
        // eslint-disable-next-line unicorn/no-null -- see comment above.
        lastName: null,
      }
    }
    next()
  })
  app.post('/endpoint', limiter, (_request, response) => {
    response.status(201).json({ success: true })
  })
  app.use(errorHandler)
  return app
}

describe('RATE_LIMITS.logout', () => {
  it('returns 429 once the limit is exceeded, keyed on IP alone', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.logout, { limit: 1, windowMs: 60_000 })
    )

    const allowed = await request(app).post('/endpoint')
    const limited = await request(app).post('/endpoint')

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

describe('the 429 message', () => {
  it('names when to try again, matching the Retry-After it answers with', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.logout, { limit: 1, windowMs: 15 * 60_000 })
    )

    await request(app).post('/endpoint')
    const limited = await request(app).post('/endpoint')

    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers['retry-after'])
    // A 15-minute window just opened: the header is 899 or 900 seconds, both 15 minutes.
    expect(retryAfter).toBeGreaterThan(14 * 60)
    expect((limited.body as { message?: string }).message).toBe(
      "You've reached the limit of 1 attempt in 15 minutes. Try again in 15 minutes."
    )
  })

  it("names the spec's own unit", async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.authenticatedWrite, { limit: 1, windowMs: 30_000 })
    )
    const userId = randomUUID()

    await request(app).post('/endpoint').set('x-test-user-id', userId)
    const limited = await request(app).post('/endpoint').set('x-test-user-id', userId)

    expect((limited.body as { message?: string }).message).toMatch(
      /^You've reached the limit of 1 request in 30 seconds\. Try again in \d+ seconds\.$/
    )
  })
})

describe('RATE_LIMITS.createTenant', () => {
  it('returns 429 with standardized RateLimit-* headers once the limit is exceeded', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.createTenant, { limit: 2, windowMs: 60_000 })
    )
    const userId = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', userId)
    const second = await request(app).post('/endpoint').set('x-test-user-id', userId)
    const limited = await request(app).post('/endpoint').set('x-test-user-id', userId)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(limited.headers).toHaveProperty('ratelimit-limit')
    expect(limited.headers).not.toHaveProperty('x-ratelimit-limit')
  })

  /**
   * The property that makes this limiter genuinely different from every
   * IP-keyed one above, proven directly: two different authenticated
   * callers behind the same client IP must not share a counter. Red if
   * `RATE_LIMITS.createTenant` were built with express-rate-limit's
   * default IP-based `keyGenerator` instead of
   * `authenticatedUserRateLimitKey` — every request in this test would
   * then land in the same bucket regardless of `x-test-user-id`, and
   * `bystander` below would come back 429 instead of 201.
   */
  it('keys on the authenticated user id, not IP: a different user is unaffected by another user’s counter', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.createTenant, { limit: 1, windowMs: 60_000 })
    )
    const victim = randomUUID()
    const other = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', victim)
    const victimBlocked = await request(app).post('/endpoint').set('x-test-user-id', victim)
    expect(first.status).toBe(201)
    expect(victimBlocked.status).toBe(429)

    const bystander = await request(app).post('/endpoint').set('x-test-user-id', other)
    expect(bystander.status).toBe(201)
  })

  // `authenticatedUserRateLimitKey`'s own `?? 'anonymous'` fallback, proven directly: with no `request.user` at all (no `x-test-user-id` header), every request collapses onto the one shared `'anonymous'` bucket rather than the key generator throwing — the fail-safe direction, not a crash.
  it('falls back to one shared bucket when request.user is unset, rather than throwing', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.createTenant, { limit: 1, windowMs: 60_000 })
    )

    const first = await request(app).post('/endpoint')
    const second = await request(app).post('/endpoint')

    expect(first.status).toBe(201)
    expect(second.status).toBe(429)
  })
})

describe('RATE_LIMITS.inviteTenantMember', () => {
  it('returns 429 with standardized RateLimit-* headers once the limit is exceeded', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.inviteTenantMember, { limit: 2, windowMs: 60_000 })
    )
    const userId = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', userId)
    const second = await request(app).post('/endpoint').set('x-test-user-id', userId)
    const limited = await request(app).post('/endpoint').set('x-test-user-id', userId)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })

  // Same discriminator as `RATE_LIMITS.createTenant` above, proven again for this limiter specifically — the two share `createRateLimiter` and `authenticatedUserRateLimitKey`, but each is a distinct `RATE_LIMITS` entry with its own store prefix, so each is proven independently rather than one standing in for both.
  it('keys on the authenticated user id, not IP: a different user is unaffected by another user’s counter', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.inviteTenantMember, { limit: 1, windowMs: 60_000 })
    )
    const victim = randomUUID()
    const other = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', victim)
    const victimBlocked = await request(app).post('/endpoint').set('x-test-user-id', victim)
    expect(first.status).toBe(201)
    expect(victimBlocked.status).toBe(429)

    const bystander = await request(app).post('/endpoint').set('x-test-user-id', other)
    expect(bystander.status).toBe(201)
  })
})

describe('RATE_LIMITS.invitationPreview', () => {
  it('returns 429 once the limit is exceeded, keyed on IP alone', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.invitationPreview, { limit: 1, windowMs: 60_000 })
    )

    const allowed = await request(app).post('/endpoint')
    const limited = await request(app).post('/endpoint')

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

describe('RATE_LIMITS.invitationAccept', () => {
  // Keyed on the user, behind requireAuth: a second signed-in caller behind the same IP keeps their own budget.
  it('returns 429 once one user spends the budget, and keys on the user id', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.invitationAccept, { limit: 1, windowMs: 60_000 })
    )
    const invitee = randomUUID()

    const allowed = await request(app).post('/endpoint').set('x-test-user-id', invitee)
    const limited = await request(app).post('/endpoint').set('x-test-user-id', invitee)
    const bystander = await request(app).post('/endpoint').set('x-test-user-id', randomUUID())

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(bystander.status).toBe(201)
  })
})

describe('RATE_LIMITS.platformSearch', () => {
  it('returns 429 once one user spends the budget, and keys on the user id', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.platformSearch, { limit: 1, windowMs: 60_000 })
    )
    const staff = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', staff)
    const limited = await request(app).post('/endpoint').set('x-test-user-id', staff)
    const bystander = await request(app).post('/endpoint').set('x-test-user-id', randomUUID())

    expect(first.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(bystander.status).toBe(201)
  })
})

describe('RATE_LIMITS.authenticatedWrite', () => {
  it('returns 429 at the 61st request within a minute, per user', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.authenticatedWrite, { limit: 60, windowMs: 60_000 })
    )
    const userId = randomUUID()

    for (let index = 0; index < 60; index += 1) {
      const allowed = await request(app).post('/endpoint').set('x-test-user-id', userId)
      expect(allowed.status).toBe(201)
    }
    const limited = await request(app).post('/endpoint').set('x-test-user-id', userId)

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })

  it('keys on the authenticated user id: a second user is unaffected', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.authenticatedWrite, { limit: 1, windowMs: 60_000 })
    )
    const victim = randomUUID()
    const other = randomUUID()

    const first = await request(app).post('/endpoint').set('x-test-user-id', victim)
    const victimBlocked = await request(app).post('/endpoint').set('x-test-user-id', victim)
    expect(first.status).toBe(201)
    expect(victimBlocked.status).toBe(429)

    const bystander = await request(app).post('/endpoint').set('x-test-user-id', other)
    expect(bystander.status).toBe(201)
  })
})

describe('createRateLimiter marks its output', () => {
  it('sets RATE_LIMITER_MARK to the spec name on the returned middleware', () => {
    const handler = createRateLimiter(RATE_LIMITS.logout)
    expect((handler as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe('logout')
  })
})

describe('store prefix derivation', () => {
  /**
   * The list of names and their order live in
   * tests/unit/constants/rate-limit.constants.test.ts, asserted directly
   * against the real RATE_LIMITS object. What that test alone cannot
   * prove is that createRateLimiter actually threads spec.name into
   * limiterStore(...) rather than a hardcoded literal — a hardcoded 'rl'
   * prefix would pass every RATE_LIMITS assertion while merging every
   * limiter's Redis counter into one bucket. Asserted against the
   * committed source, the same way tests/unit/connection-target.test.ts
   * guards the compose ports: express-rate-limit's middleware exposes
   * `resetKey`/`getKey` but not its `store`, so this is not observable at
   * runtime.
   */
  it("derives every limiter's store prefix from spec.name, not a hardcoded string", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/middlewares/rate-limit.middleware.ts'),
      'utf8'
    )
    expect(source).toMatch(/store:\s*limiterStore\(spec\.name\)/)
  })
})

/**
 * The environment `getEnv()` answers outside the RATE_LIMIT_SCALE tests.
 */
const realEnv = getEnv()

/**
 * Makes every `getEnv()` answer the real environment with `overrides` on top,
 * until the describe's `afterEach` restores it. `createRateLimiter` reads it
 * once, when it builds the limiter.
 */
function useEnv(overrides: Partial<Env>): void {
  vi.mocked(getEnv).mockReturnValue({ ...realEnv, ...overrides })
}

/**
 * The logout spec with a budget of one, so a test spends exactly the scale.
 */
const ONE_PER_WINDOW: RateLimiterSpec = { ...RATE_LIMITS.logout, limit: 1 }

/**
 * Sends `count` requests to `app` one after another and returns their statuses, in order.
 */
async function statuses(app: Express, count: number): Promise<number[]> {
  const seen: number[] = []
  for (let index = 0; index < count; index += 1) {
    const response = await request(app).post('/endpoint')
    seen.push(response.status)
  }
  return seen
}

describe('RATE_LIMIT_SCALE', () => {
  afterEach(() => {
    vi.mocked(getEnv).mockReturnValue(realEnv)
  })

  it("multiplies the spec's limit by the scale on local, in the 429 and the RateLimit-Limit header", async () => {
    useEnv({ APP_ENV: 'local', RATE_LIMIT_SCALE: 3 })
    const app = buildAppBehind(createRateLimiter(ONE_PER_WINDOW))

    expect(await statuses(app, 3)).toEqual([201, 201, 201])
    const limited = await request(app).post('/endpoint')

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(limited.headers['ratelimit-limit']).toBe('3')
  })

  it("leaves the spec's limit as it is when RATE_LIMIT_SCALE is unset", async () => {
    useEnv({ APP_ENV: 'local', RATE_LIMIT_SCALE: undefined })
    const app = buildAppBehind(createRateLimiter(ONE_PER_WINDOW))

    expect(await statuses(app, 2)).toEqual([201, 429])
  })

  it.each(['dev', 'qa', 'prod'] as const)(
    'ignores a scale on APP_ENV=%s, where boot would have refused it',
    async (appEnv) => {
      useEnv({ APP_ENV: appEnv, RATE_LIMIT_SCALE: 3 })
      const app = buildAppBehind(createRateLimiter(ONE_PER_WINDOW))

      expect(await statuses(app, 2)).toEqual([201, 429])
    }
  )

  it('uses an overridden limit as given, unscaled', async () => {
    useEnv({ APP_ENV: 'local', RATE_LIMIT_SCALE: 3 })
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.logout, { limit: 1, windowMs: 60_000 })
    )

    expect(await statuses(app, 2)).toEqual([201, 429])
  })
})
