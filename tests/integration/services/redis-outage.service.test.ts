// tests/integration/services/redis-outage.service.test.ts
//
// A real Redis outage without touching the shared compose Redis: both clients
// connect through a TCP proxy this file owns, and the outage is the proxy
// resetting every connection. Its own file because it mocks getEnv()'s
// REDIS_URL (same reason as redis-unreachable.service.test.ts).
//
// The proxy holds one port for the whole file: re-listening on a hand-picked
// port could take over another worker's test server on that port.
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorHandler } from '@/middlewares/error.middleware'
import { createLoginRateLimiter } from '@/middlewares/rate-limit.middleware'
import {
  addJob,
  closeQueue,
  getEmailQueue,
  getQueueConnection,
  isQueueReachable,
} from '@/services/queue.service'
import { closeRedis, isRedisReachable } from '@/services/redis.service'

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

// `down` resets every connection; `silent` accepts connections and never answers.
type ProxyMode = 'up' | 'down' | 'silent'

class RedisProxy {
  private server: net.Server | undefined
  private readonly sockets = new Set<net.Socket>()
  private mode: ProxyMode = 'up'
  port = 0

  private switchTo(mode: ProxyMode): void {
    this.mode = mode
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  async start(upstream: URL): Promise<void> {
    const server = net.createServer((client) => {
      if (this.mode === 'down') {
        client.resetAndDestroy()
        return
      }
      this.sockets.add(client)
      client.on('error', () => client.destroy()).on('close', () => this.sockets.delete(client))
      if (this.mode === 'silent') return

      const toRedis = net.connect(Number(upstream.port || 6379), upstream.hostname)
      this.sockets.add(toRedis)
      client.pipe(toRedis).pipe(client)
      const teardown = (): void => {
        client.destroy()
        toRedis.destroy()
        this.sockets.delete(client)
        this.sockets.delete(toRedis)
      }
      client.on('error', teardown).on('close', teardown)
      toRedis.on('error', teardown).on('close', teardown)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (server.address() as net.AddressInfo).port
    this.server = server
  }

  goDown(): void {
    this.switchTo('down')
  }

  goSilent(): void {
    this.switchTo('silent')
  }

  comeBack(): void {
    // Leaves live connections alone when already up; otherwise drops silent ones.
    if (this.mode !== 'up') this.switchTo('up')
  }

  close(): void {
    this.switchTo('down')
    this.server?.close()
    this.server = undefined
  }
}

const proxy = new RedisProxy()

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function isEventuallyTrue(
  isDone: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDone()) return true
    await sleep(100)
  }
  return false
}

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
    const proxied = new URL(target.realUrl)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(proxy.port)
    target.proxyUrl = proxied.href
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
    app.post('/login', createLoginRateLimiter({ limit: 2 }), (_request, response) => {
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
