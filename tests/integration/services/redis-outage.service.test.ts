// tests/integration/services/redis-outage.service.test.ts
//
// A real Redis outage without touching the shared compose Redis: both clients
// connect through a TCP proxy this file owns, and the outage is the proxy
// refusing connections. Its own file because it mocks getEnv()'s REDIS_URL
// (same reason as redis-unreachable.service.test.ts).
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { errorHandler } from '@/middlewares/error.middleware'
import { createLoginRateLimiter } from '@/middlewares/rate-limit.middleware'
import { closeQueue, isQueueReachable } from '@/services/queue.service'
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

class RedisProxy {
  private server: net.Server | undefined
  private readonly sockets = new Set<net.Socket>()
  port = 0

  async start(upstream: URL): Promise<void> {
    const server = net.createServer((client) => {
      const toRedis = net.connect(Number(upstream.port || 6379), upstream.hostname)
      this.sockets.add(client)
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
      server.listen(this.port, '127.0.0.1', () => resolve())
    })
    this.port = (server.address() as net.AddressInfo).port
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
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
  proxy.stop()
  await sleep(OUTAGE_MS)
  await proxy.start(new URL(target.realUrl))
}

describe('Redis clients survive an outage', () => {
  beforeAll(async () => {
    await proxy.start(new URL(target.realUrl))
    const proxied = new URL(target.realUrl)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(proxy.port)
    target.proxyUrl = proxied.href
  })

  afterAll(async () => {
    await closeRedis()
    await closeQueue()
    proxy.stop()
  })

  it('node-redis reports unreachable promptly during an outage, then reconnects after it', async () => {
    expect(await isRedisReachable()).toBe(true)

    proxy.stop()
    await sleep(100)
    const probedAt = Date.now()
    expect(await isRedisReachable()).toBe(false)
    expect(Date.now() - probedAt).toBeLessThan(500)
    await sleep(OUTAGE_MS)
    await proxy.start(new URL(target.realUrl))

    expect(await isEventuallyTrue(isRedisReachable, 5000)).toBe(true)
  }, 10_000)

  it('the BullMQ ioredis connection reports unreachable promptly during an outage, then reconnects', async () => {
    expect(await isQueueReachable()).toBe(true)

    proxy.stop()
    await sleep(100)
    const probedAt = Date.now()
    expect(await isQueueReachable()).toBe(false)
    expect(Date.now() - probedAt).toBeLessThan(500)
    await sleep(OUTAGE_MS)
    await proxy.start(new URL(target.realUrl))

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

    proxy.stop()
    await sleep(100)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app).post('/login').send(body)
      statuses.push(response.status)
    }
    // Per-process memory counting: a fresh count of 2 allowed, then 429.
    expect(statuses).toEqual([401, 401, 429])

    await proxy.start(new URL(target.realUrl))
    expect(await isEventuallyTrue(isRedisReachable, 5000)).toBe(true)
  }, 10_000)
})
