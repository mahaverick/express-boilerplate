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
import fs from 'node:fs'
import path from 'node:path'
import express, { type Express, type RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { errorHandler } from '@/middlewares/error.middleware'
import {
  createLoginRateLimiter,
  createLogoutRateLimiter,
  createRegisterRateLimiter,
  RATE_LIMITED_CODE,
} from '@/middlewares/rate-limit.middleware'

vi.mock('@/services/redis.service', () => ({
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
  app.post('/login', createLoginRateLimiter({ limit, windowMs: 60_000 }), (_request, response) => {
    response.status(401).json({ success: false, message: 'Invalid email or password' })
  })
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
 * POST a login attempt.
 * @param app - The app under test.
 * @param email - The email to submit.
 * @param password - The password to submit. Defaults to a fixed wrong one — never checked by the stub handler.
 * @returns The supertest response.
 */
function attempt(app: Express, email: string, password = 'wrong-password'): request.Test {
  return request(app).post('/login').send({ email, password })
}

describe('createLoginRateLimiter', () => {
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

describe('createRegisterRateLimiter', () => {
  it('returns 429 with standardized RateLimit-* headers once the limit is exceeded', async () => {
    const app = buildAppBehind(createRegisterRateLimiter({ limit: 2, windowMs: 60_000 }))

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
    const app = buildAppBehind(createRegisterRateLimiter({ limit: 2, windowMs: 60_000 }))

    await request(app).post('/endpoint').send({ email: 'first@example.com' })
    await request(app).post('/endpoint').send({ email: 'second@example.com' })
    const third = await request(app).post('/endpoint').send({ email: 'third@example.com' })

    expect(third.status).toBe(429)
  })

  it('counts a request carrying no email at all against the same IP counter', async () => {
    const app = buildAppBehind(createRegisterRateLimiter({ limit: 1, windowMs: 60_000 }))

    await request(app).post('/endpoint').send({ email: 'someone@example.com' })
    const bodyless = await request(app).post('/endpoint')

    expect(bodyless.status).toBe(429)
  })
})

describe('createLogoutRateLimiter', () => {
  it('returns 429 once the limit is exceeded, keyed on IP alone', async () => {
    const app = buildAppBehind(createLogoutRateLimiter({ limit: 1, windowMs: 60_000 }))

    const allowed = await request(app).post('/endpoint')
    const limited = await request(app).post('/endpoint')

    expect(allowed.status).toBe(201)
    expect(limited.status).toBe(429)
    expect(limited.body).toMatchObject({ success: false, code: RATE_LIMITED_CODE })
  })
})

describe('store prefixes', () => {
  // The convention rate-limit.middleware.ts's header comment establishes,
  // pinned as a test rather than only as prose: every limiter carries its
  // own SharedRateLimitStore prefix, so no two endpoints can ever spend each
  // other's budget once the store latches onto Redis. B3 adds
  // forgot-password and resend-verification, and this is the assertion that
  // fails if either copies an existing prefix.
  //
  // Asserted against the committed source, the same way
  // tests/unit/connection-target.test.ts guards the compose ports and
  // password.utilities.test.ts guards SECURITY.md's stated bcrypt cost: a
  // built limiter exposes only `resetKey`/`getKey` (verified — no `store`
  // property), so the invariant simply is not observable at runtime. The
  // file that declares the prefixes is the thing worth guarding.
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/middlewares/rate-limit.middleware.ts'),
    'utf8'
  )
  const prefixes = Array.from(
    source.matchAll(/new SharedRateLimitStore\('([^']+)'\)/g),
    (match) => match[1]
  )

  it('builds one store per limiter, each with its own prefix', () => {
    expect(prefixes).toEqual([
      'rl:register:',
      'rl:login:',
      'rl:refresh:',
      'rl:logout:',
      'rl:verify-email:',
      'rl:resend-verification-ip:',
      'rl:resend-verification-email:',
    ])
  })

  it('never reuses a prefix across two limiters', () => {
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})
