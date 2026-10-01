/**
 * @file The two webhook limiters' counting rules, on a bare app with the
 * in-memory store: `emailWebhook` spends its budget only on accepted
 * requests and `emailWebhookRejected` only on refused ones, so unsigned
 * traffic can neither drain a provider's budget nor be counted against a
 * provider that signs correctly. Limits are small overrides of the real
 * specs; the stub handler accepts a request carrying `x-ok`.
 */
import express, { type Express } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import { createRateLimiter, RATE_LIMITED_CODE } from '@/middlewares/rate-limit.middleware'
import { request } from '../../helpers/request'

vi.mock('@/services/redis.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/redis.service')>()),
  getRedis: vi.fn(() => Promise.reject(new Error('no redis in unit tests'))),
}))

const WINDOW = { windowMs: 60_000 }

/**
 * Build the two limiters in the route's order in front of a stub handler.
 * @param providerLimit - The per-provider budget.
 * @param rejectedLimit - The per-IP budget for refused requests.
 * @returns The app; `X-Forwarded-For` sets the caller's IP.
 */
function buildApp(providerLimit: number, rejectedLimit: number): Express {
  const app = express()
  app.set('trust proxy', true)
  app.post(
    '/:provider',
    createRateLimiter(RATE_LIMITS.emailWebhookRejected, { ...WINDOW, limit: rejectedLimit }),
    createRateLimiter(RATE_LIMITS.emailWebhook, { ...WINDOW, limit: providerLimit }),
    (incoming, outgoing) => {
      if (incoming.header('x-ok') === undefined) {
        outgoing.status(401).json({ success: false })
        return
      }
      outgoing.status(200).json({ success: true })
    }
  )
  app.use(errorHandler)
  return app
}

describe('webhook limiters', () => {
  it('lets a signed request through after a flood of unsigned ones from other addresses', async () => {
    const app = buildApp(3, 1000)
    for (let index = 0; index < 8; index += 1) {
      const forged = await request(app)
        .post('/resend')
        .set('X-Forwarded-For', `203.0.113.${String(index + 1)}`)
      expect(forged.status).toBe(401)
    }

    const signed = await request(app)
      .post('/resend')
      .set('X-Forwarded-For', '198.51.100.9')
      .set('x-ok', '1')

    expect(signed.status).toBe(200)
  })

  it('still answers 429 to accepted requests beyond the provider budget', async () => {
    const app = buildApp(2, 1000)
    const statuses: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const response = await request(app).post('/resend').set('x-ok', '1')
      statuses.push(response.status)
    }
    expect(statuses).toEqual([200, 200, 429])
  })

  it('answers 429 RATE_LIMITED to one address that keeps sending unsigned requests', async () => {
    const app = buildApp(1000, 3)
    const statuses: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const response = await request(app).post('/resend').set('X-Forwarded-For', '203.0.113.7')
      statuses.push(response.status)
    }
    expect(statuses).toEqual([401, 401, 401, 429])

    const other = await request(app).post('/resend').set('X-Forwarded-For', '203.0.113.8')
    expect(other.status).toBe(401)
    const limited = await request(app).post('/resend').set('X-Forwarded-For', '203.0.113.7')
    expect(limited.body).toMatchObject({ code: RATE_LIMITED_CODE })
  })

  it('does not spend the rejected-request budget on signed requests', async () => {
    const app = buildApp(1000, 2)
    for (let index = 0; index < 6; index += 1) {
      const signed = await request(app)
        .post('/resend')
        .set('X-Forwarded-For', '203.0.113.7')
        .set('x-ok', '1')
      expect(signed.status).toBe(200)
    }
    const forged = await request(app).post('/resend').set('X-Forwarded-For', '203.0.113.7')
    expect(forged.status).toBe(401)
  })
})
