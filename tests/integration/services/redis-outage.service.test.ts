// tests/integration/services/redis-outage.service.test.ts
//
// A real Redis outage without touching the shared compose Redis: both clients
// connect through a TCP proxy this file owns (tests/helpers/redis-proxy.ts).
// Its own file because it mocks getEnv()'s REDIS_URL (same reason as
// redis-unreachable.service.test.ts).
import { randomUUID } from 'node:crypto'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'
import {
  addJob,
  closeQueue,
  getEmailQueue,
  getQueueConnection,
  isQueueReachable,
} from '@/services/queue.service'
import { closeRedis, isRedisReachable } from '@/services/redis.service'
import { isEventuallyTrue, RedisProxy, sleep } from '../../helpers/redis-proxy'
import { request } from '../../helpers/request'

// Longer than either client's pre-fix retry budget (node-redis ~600ms, ioredis ~1.2s).
const OUTAGE_MS = 1500

const target = vi.hoisted(() => ({ realUrl: '', proxyUrl: '' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  target.realUrl = actual.getEnv().REDIS_URL
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), REDIS_URL: target.proxyUrl }),
  }
})

const proxy = new RedisProxy()

async function simulateOutage(): Promise<void> {
  proxy.goDown()
  await sleep(OUTAGE_MS)
  proxy.comeBack()
}

/**
 * Settle a promise, or report that it was still pending after `ms`.
 * @param operation - The operation under test.
 * @param ms - How long to wait before calling it hung.
 * @returns How it settled, or `'hung'`.
 */
async function settleWithin(operation: Promise<unknown>, ms: number): Promise<string> {
  const settled = (async () => {
    try {
      await operation
      return 'resolved'
    } catch {
      return 'rejected'
    }
  })()
  const timedOut = (async () => {
    await sleep(ms)
    return 'hung'
  })()
  return Promise.race([settled, timedOut])
}

describe('Redis clients survive an outage', () => {
  beforeAll(async () => {
    await proxy.start(new URL(target.realUrl))
    target.proxyUrl = proxy.urlFor(new URL(target.realUrl))
  })

  // A failed test must not leave the next one talking to a dead proxy.
  afterEach(() => {
    proxy.comeBack()
  })

  afterAll(async () => {
    await closeRedis()
    await closeQueue()
    proxy.close()
  })

  // First: it needs queue connections that have never been ready.
  it('replaces queue connections whose first connect failed in an outage, so enqueues work once Redis returns', async () => {
    proxy.goDown()
    expect(await isQueueReachable()).toBe(false)
    const duringOutage = addJob(getEmailQueue(), 'outage-probe', { to: 'outage@example.test' })
    expect(await settleWithin(duringOutage, 5000)).toBe('rejected')

    proxy.comeBack()
    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
    const job = await addJob(getEmailQueue(), 'recovery-probe', { to: 'recovery@example.test' })
    expect(job.id).toBeDefined()
    await job.remove()
  }, 15_000)

  it('node-redis reports unreachable promptly during an outage, then reconnects after it', async () => {
    expect(await isRedisReachable()).toBe(true)

    proxy.goDown()
    await sleep(100)
    const probedAt = Date.now()
    expect(await isRedisReachable()).toBe(false)
    expect(Date.now() - probedAt).toBeLessThan(500)
    await sleep(OUTAGE_MS)
    proxy.comeBack()

    expect(await isEventuallyTrue(isRedisReachable, 5000)).toBe(true)
  }, 10_000)

  it('the BullMQ ioredis connection reports unreachable promptly during an outage, then reconnects', async () => {
    expect(await isQueueReachable()).toBe(true)

    proxy.goDown()
    await sleep(100)
    const probedAt = Date.now()
    expect(await isQueueReachable()).toBe(false)
    expect(Date.now() - probedAt).toBeLessThan(500)
    await sleep(OUTAGE_MS)
    proxy.comeBack()

    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
  }, 10_000)

  it('both clients also survive a second outage', async () => {
    await simulateOutage()
    expect(await isEventuallyTrue(isRedisReachable, 5000)).toBe(true)
    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
  }, 10_000)

  it('keeps the login limiter counting, never answering 500, while Redis is down', async () => {
    const app = express()
    app.use(express.json())
    // Stands in for the login handler: every attempt is a wrong password.
    app.post('/login', createRateLimiter(RATE_LIMITS.login, { limit: 2 }), (_request, response) => {
      response.status(401).json({ success: false })
    })
    app.use(errorHandler)
    const body = { email: `outage-${randomUUID()}@example.test`, password: 'wrong' }

    // Counted in Redis (the store switches to Redis on this first request).
    const counted = await request(app).post('/login').send(body)
    expect(counted.status).toBe(401)

    proxy.goDown()
    await sleep(100)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app).post('/login').send(body)
      statuses.push(response.status)
    }
    // Per-process memory counting: a fresh count of 2 allowed, then 429.
    expect(statuses).toEqual([401, 401, 429])

    proxy.comeBack()
    expect(await isEventuallyTrue(isRedisReachable, 5000)).toBe(true)
  }, 10_000)

  it('reports the queue connection unreachable promptly while it reconnects to a silent Redis', async () => {
    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)

    proxy.goSilent()
    // The reconnect lands on the silent proxy: TCP connects, the ready check never answers.
    const isStuckConnecting = await isEventuallyTrue(
      () => Promise.resolve(['connecting', 'connect'].includes(getQueueConnection().status)),
      3000
    )
    expect(isStuckConnecting).toBe(true)
    const probedAt = Date.now()
    expect(await settleWithin(isQueueReachable(), 1000)).toBe('resolved')
    expect(await isQueueReachable()).toBe(false)
    expect(Date.now() - probedAt).toBeLessThan(500)

    proxy.comeBack()
    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
  }, 10_000)

  it('rejects an enqueue promptly during an outage instead of holding the caller until Redis returns', async () => {
    await getEmailQueue().waitUntilReady()

    proxy.goDown()
    await sleep(100)
    const enqueuedAt = Date.now()
    const outcome = await settleWithin(
      addJob(getEmailQueue(), 'outage-probe', { to: 'outage@example.test' }),
      1000
    )
    expect(outcome).toBe('rejected')
    expect(Date.now() - enqueuedAt).toBeLessThan(500)

    proxy.comeBack()
    expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
  }, 10_000)

  // Last: closeQueue() is final for this module.
  it('closes the queue promptly during an outage, even with a command waiting to be sent', async () => {
    await getEmailQueue().waitUntilReady()

    proxy.goDown()
    await sleep(100)
    // Waits in the Worker connection's offline queue, like a Worker's own commands.
    const pendingPing = settleWithin(getQueueConnection().ping(), 1000)
    expect(await settleWithin(closeQueue(), 1000)).toBe('resolved')
    // Not asserted: ioredis fails it only if disconnect() lands mid-connect, not between retries.
    await pendingPing

    proxy.comeBack()
  }, 10_000)
})
