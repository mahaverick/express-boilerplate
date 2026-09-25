// tests/unit/middlewares/rate-limit.middleware.test.ts
//
// The limiter's own logic, isolated from the database and from real Redis:
// `@/services/redis.service` is mocked to always reject, so
// `SharedRateLimitStore` stays on its in-memory fallback for the whole file
// — deterministic, and Docker-independent, which is what keeps this a
// tests/unit/ file (see CLAUDE.md on why a Docker-dependent test must never
// live there). A bare `express()` app stands in for `createApp()`: importing
// `@/app` here would pull in `database.service.ts` at module scope for no
// reason this file needs. The stub route below never checks credentials —
// it exists only so a request has somewhere to land after the limiter lets
// it through, so these tests prove the LIMITER's behaviour, not the login
// controller's (that's tests/integration/api/auth.test.ts's job).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type RequestHandler } from 'express'
import type { Test } from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import { createRateLimiter, RATE_LIMITED_CODE } from '@/middlewares/rate-limit.middleware'
import { request } from '../../helpers/request'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

/**
 * Build a bare app: a login rate limiter (small `limit`, so a test does not
 * need to make hundreds of requests) in front of a stub handler that always
 * answers 401 without looking at the credentials at all.
 * @param limit - Max attempts per window before the limiter answers 429.
 * @returns The app.
 */
function buildApp(limit: number): Express {
  const app = express()
  app.use(express.json())
  app.post(
    '/login',
    createRateLimiter(RATE_LIMITS.login, { limit, windowMs: 60_000 }),
    (_request, response) => {
      response.status(401).json({ success: false, message: 'Invalid email or password' })
    }
  )
  app.use(errorHandler)
  return app
}

/**
 * Build a bare app behind an arbitrary limiter, answering 201 when the
 * request gets through. Used for the limiters that are NOT keyed on the
 * request body, where the stub's own status only has to be distinguishable
 * from a 429.
 * @param limiter - The limiter middleware to put in front of the stub handler.
 * @returns The app.
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
 * Build a bare app behind an arbitrary limiter, the same as `buildAppBehind`
 * except a stub middleware runs FIRST and populates `request.user` from a
 * test-only `x-test-user-id` header — standing in for `requireAuth`
 * (tenant.routes.ts mounts the real one router-wide ahead of both limiters
 * this app exercises). A header, not a fixed id baked into the app, so one
 * app instance (and therefore one shared limiter/store) can simulate
 * several different authenticated callers across separate requests — the
 * same "vary the identity per request, not per app" shape
 * `loginRateLimitKey`'s own discriminator test achieves by varying the
 * submitted email.
 * @param limiter - The limiter middleware to put in front of the stub handler.
 * @returns The app.
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

/**
 * POST a login attempt.
 * @param app - The app under test.
 * @param email - The email to submit.
 * @param password - The password to submit. Defaults to a fixed wrong one — never checked by the stub handler.
 * @returns The supertest response.
 */
function attempt(app: Express, email: string, password = 'wrong-password'): Test {
  return request(app).post('/login').send({ email, password })
}

describe('RATE_LIMITS.login', () => {
  it('returns 429 with standardized RateLimit-* headers (never the legacy X-RateLimit-* ones) once the limit is exceeded', async () => {
    const app = buildApp(2)

    const firstAttempt = await attempt(app, 'victim@example.com')
    const secondAttempt = await attempt(app, 'victim@example.com')
    expect(firstAttempt.status).toBe(401)
    expect(secondAttempt.status).toBe(401)
    const limited = await attempt(app, 'victim@example.com')

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(limited.headers).toHaveProperty('ratelimit-limit')
    expect(limited.headers).toHaveProperty('ratelimit-remaining')
    expect(limited.headers).not.toHaveProperty('x-ratelimit-limit')
  })

  // Property 4. Red without the composite key: keying on email alone makes
  // this exact scenario fail — see task-7-report.md for the red/green proof.
  it('keys on IP AND email: exhausting one email does not lock out a different email from the same IP', async () => {
    const app = buildApp(2)

    await attempt(app, 'victim@example.com')
    await attempt(app, 'victim@example.com')
    const victimBlocked = await attempt(app, 'victim@example.com')
    expect(victimBlocked.status).toBe(429)

    // A different email, same supertest agent — so the same client IP —
    // must be entirely unaffected by victim@example.com's counter.
    const bystander = await attempt(app, 'someone-else@example.com')
    expect(bystander.status).toBe(401)
  })

  // Judgement call: a 429 must never be a user-enumeration oracle. The
  // limiter imports no repository and never learns whether an email is
  // registered, so the number of attempts before a 429 — and the 429 body
  // itself — cannot depend on registration status. Proven directly, not
  // just argued: an unregistered-looking email and a registered-looking one
  // trip the SAME limiter after the SAME number of attempts, with an
  // IDENTICAL response.
  it('rate-limits a never-registered-looking email exactly like a registered-looking one', async () => {
    const app = buildApp(1)

    await attempt(app, 'never-registered@example.com')
    const unknownBlocked = await attempt(app, 'never-registered@example.com')

    await attempt(app, 'registered@example.com')
    const registeredBlocked = await attempt(app, 'registered@example.com')

    expect(unknownBlocked.status).toBe(429)
    expect(unknownBlocked.status).toBe(registeredBlocked.status)
    expect(unknownBlocked.body).toEqual(registeredBlocked.body)
  })

  it('normalises the submitted email before keying, so case alone cannot dodge the limit', async () => {
    const app = buildApp(1)

    await attempt(app, 'Case@Example.com')
    const blocked = await attempt(app, 'case@example.com')

    expect(blocked.status).toBe(429)
  })

  it('keys consistently even when the request carries no usable email, rather than crashing', async () => {
    const app = buildApp(1)

    const first = await request(app).post('/login').send({ password: 'wrong-password' })
    const second = await request(app).post('/login').send({ password: 'wrong-password' })

    expect(first.status).toBe(401)
    expect(second.status).toBe(429)
  })
})

describe('RATE_LIMITS.loginIp', () => {
  it('returns 429 once one IP spends its budget, even with a different email every time', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.loginIp, { limit: 3, windowMs: 60_000 })
    )

    for (let index = 0; index < 3; index += 1) {
      const allowed = await request(app)
        .post('/endpoint')
        .send({ email: `user-${index}@example.com` })
      expect(allowed.status).toBe(201)
    }
    const limited = await request(app).post('/endpoint').send({ email: 'user-3@example.com' })

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

/**
 * The account limiter behind a proxy-aware bare app, so each request can
 * claim its own client IP via X-Forwarded-For. 'loopback' trusts exactly
 * supertest's 127.0.0.1 hop; `true` would trip express-rate-limit's
 * permissive-trust-proxy validation.
 * @param limit - Max attempts per window.
 * @returns The app.
 */
function buildAccountLimitedApp(limit: number): Express {
  const app = buildAppBehind(
    createRateLimiter(RATE_LIMITS.loginAccount, { limit, windowMs: 60_000 })
  )
  app.set('trust proxy', 'loopback')
  return app
}

describe('RATE_LIMITS.loginAccount', () => {
  it('returns 429 once one account is guessed at from many different IPs', async () => {
    const app = buildAccountLimitedApp(3)

    for (let index = 0; index < 3; index += 1) {
      const allowed = await request(app)
        .post('/endpoint')
        .set('X-Forwarded-For', `203.0.113.${index + 1}`)
        .send({ email: 'Victim@Example.com' })
      expect(allowed.status).toBe(201)
    }
    const limited = await request(app)
      .post('/endpoint')
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ email: 'victim@example.com' })

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })

    // Another account is unaffected.
    const bystander = await request(app)
      .post('/endpoint')
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ email: 'someone-else@example.com' })
    expect(bystander.status).toBe(201)
  })
})

describe('POST /login wiring', () => {
  it('mounts the ip+email, per-IP and per-account limiters, in that order, before login', () => {
    // Asserted against the committed route file, the same way `store
    // prefix derivation` below asserts against the committed middleware
    // source: a built router does not expose which `RATE_LIMITS` entry
    // produced each piece of its middleware.
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/auth.routes.ts'), 'utf8')
    expect(routes).toMatch(
      /router\.post\(\s*'\/login',\s*createRateLimiter\(RATE_LIMITS\.login\),\s*createRateLimiter\(RATE_LIMITS\.loginIp\),\s*createRateLimiter\(RATE_LIMITS\.loginAccount\),\s*authController\.login\s*\)/
    )
  })
})

describe('RATE_LIMITS.register', () => {
  it('returns 429 with standardized RateLimit-* headers once the limit is exceeded', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.register, { limit: 2, windowMs: 60_000 })
    )

    const first = await request(app).post('/endpoint').send({ email: 'a@example.com' })
    const second = await request(app).post('/endpoint').send({ email: 'b@example.com' })
    const limited = await request(app).post('/endpoint').send({ email: 'c@example.com' })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)

    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
    expect(limited.headers).toHaveProperty('ratelimit-limit')
    expect(limited.headers).not.toHaveProperty('x-ratelimit-limit')
  })

  // The property that makes this limiter useful at all, and the one thing
  // that must differ from the login limiter: registration is keyed on IP
  // ALONE. An attacker enumerating addresses varies the email on every
  // request by construction, so a key containing the email would hand them
  // a fresh counter each time and bound nothing. Red if the register
  // limiter is given loginRateLimitKey (or any email-aware key): each of
  // these three emails would get its own budget and none would be limited.
  it('keys on IP alone: a different email on every request shares one counter', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.register, { limit: 2, windowMs: 60_000 })
    )

    await request(app).post('/endpoint').send({ email: 'first@example.com' })
    await request(app).post('/endpoint').send({ email: 'second@example.com' })
    const third = await request(app).post('/endpoint').send({ email: 'third@example.com' })

    expect(third.status).toBe(429)
  })

  it('counts a request carrying no email at all against the same IP counter', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.register, { limit: 1, windowMs: 60_000 })
    )

    await request(app).post('/endpoint').send({ email: 'someone@example.com' })
    const bodyless = await request(app).post('/endpoint')

    expect(bodyless.status).toBe(429)
  })
})

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

describe('RATE_LIMITS.forgotPasswordIp', () => {
  it('returns 429 once the limit is exceeded, keyed on IP alone', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.forgotPasswordIp, { limit: 2, windowMs: 60_000 })
    )

    const first = await request(app).post('/endpoint').send({ email: 'first@example.com' })
    const second = await request(app).post('/endpoint').send({ email: 'second@example.com' })
    const limited = await request(app).post('/endpoint').send({ email: 'third@example.com' })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

describe('RATE_LIMITS.forgotPasswordEmail', () => {
  it('keys on the submitted address alone: a different address is unaffected by the victim’s counter', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.forgotPasswordEmail, { limit: 2, windowMs: 60_000 })
    )

    await request(app).post('/endpoint').send({ email: 'victim@example.com' })
    await request(app).post('/endpoint').send({ email: 'victim@example.com' })
    const victimBlocked = await request(app).post('/endpoint').send({ email: 'victim@example.com' })
    expect(victimBlocked.status).toBe(429)

    // A different address, same supertest agent (same client IP) — must be
    // entirely unaffected by victim@example.com's counter, since an
    // attacker who knows only the victim's address must not be able to
    // spend anyone else's budget.
    const bystander = await request(app)
      .post('/endpoint')
      .send({ email: 'someone-else@example.com' })
    expect(bystander.status).toBe(201)
  })
})

describe('RATE_LIMITS.resetPassword', () => {
  it('returns 429 once the limit is exceeded, keyed on IP alone', async () => {
    const app = buildAppBehind(
      createRateLimiter(RATE_LIMITS.resetPassword, { limit: 1, windowMs: 60_000 })
    )

    const allowed = await request(app).post('/endpoint')
    const limited = await request(app).post('/endpoint')

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
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

  // The property that makes this limiter genuinely different from every
  // IP-keyed one above, and the one this file's own precedent
  // (`loginRateLimitKey`'s "keys on IP AND email" test, and the
  // `RATE_LIMITS.forgotPasswordEmail` describe block's "a different
  // address is unaffected" test) already establishes matters enough to
  // prove directly: two different authenticated callers behind the SAME
  // client IP (one supertest agent, so one shared underlying
  // connection/IP) must not share a counter. Red if `RATE_LIMITS.createTenant`
  // were built with express-rate-limit's default IP-based `keyGenerator`
  // instead of `authenticatedUserRateLimitKey` — every request in this
  // test would then land in the same bucket regardless of
  // `x-test-user-id`, and `bystander` below would come back 429 instead
  // of 201.
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

  // `authenticatedUserRateLimitKey`'s own `?? 'anonymous'` fallback, proven
  // directly: with no `request.user` at all (no `x-test-user-id` header),
  // every request collapses onto the one shared `'anonymous'` bucket rather
  // than the key generator throwing — the fail-SAFE direction its own
  // comment describes (more restrictive, never less), not a crash.
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

  // Same discriminator as `RATE_LIMITS.createTenant` above, proven again
  // for this limiter specifically — the two share `createRateLimiter` and
  // `authenticatedUserRateLimitKey`, but each is a distinct `RATE_LIMITS`
  // entry with its own store prefix, so each is proven independently
  // rather than one standing in for both.
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
  // Keyed on IP, not the user: two different signed-in callers behind one
  // IP share the bucket, because the limiter runs before requireAuth.
  it('returns 429 once the limit is exceeded, whoever the caller claims to be', async () => {
    const app = buildAppBehindAsUser(
      createRateLimiter(RATE_LIMITS.invitationAccept, { limit: 1, windowMs: 60_000 })
    )

    const allowed = await request(app).post('/endpoint').set('x-test-user-id', randomUUID())
    const limited = await request(app).post('/endpoint').set('x-test-user-id', randomUUID())

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

describe('store prefix derivation', () => {
  // The 19-name list and order now live in
  // tests/unit/constants/rate-limit.constants.test.ts, asserted directly
  // against the real RATE_LIMITS object. What that test alone cannot prove
  // is that createRateLimiter actually THREADS spec.name into
  // limiterStore(...) rather than a hardcoded literal — a hardcoded
  // 'rl' prefix would pass every RATE_LIMITS assertion while merging every
  // limiter's Redis counter into one bucket. Asserted against the committed
  // source, the same way tests/unit/connection-target.test.ts guards the
  // compose ports and password.utilities.test.ts guards SECURITY.md's
  // stated bcrypt cost: a built limiter exposes only `resetKey`/`getKey`
  // (verified — no `store` property), so this is not observable at runtime.
  it("derives every limiter's store prefix from spec.name, not a hardcoded string", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/middlewares/rate-limit.middleware.ts'),
      'utf8'
    )
    expect(source).toMatch(/store:\s*limiterStore\(spec\.name\)/)
  })
})
