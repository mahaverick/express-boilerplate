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
import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { errorHandler } from '@/middlewares/error.middleware'
import { createLoginRateLimiter, RATE_LIMITED_CODE } from '@/middlewares/rate-limit.middleware'

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
