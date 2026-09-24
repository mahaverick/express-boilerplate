// tests/integration/services/redis-unreachable.service.test.ts
//
// Isolated from redis.service.test.ts on purpose: this file mocks
// getEnv() to point REDIS_URL at a dead port for every test in it, so it
// cannot share a module registry (and therefore a mocked getEnv) with
// tests that need the real, reachable compose-stack Redis. Vitest gives
// each test file its own module registry by default, which is what makes
// this safe.
//
// Before the reconnectStrategy fix in redis.service.ts, node-redis's
// default strategy retried forever and connect() never rejected — so
// isRedisReachable() (and therefore GET /health/ready) hung indefinitely
// instead of reporting unreachable. This test pins that regression down:
// it fails by TIMING OUT, not by a mismatched assertion, if the strategy
// is ever removed.
import { createClient } from 'redis'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { closeRedis, getRedis, isRedisReachable } from '@/services/redis.service'

// Wrapped, not replaced: counts how many clients getRedis() creates.
vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>()
  return { ...actual, createClient: vi.fn(actual.createClient) }
})

// vi.mock calls are hoisted above these imports by Vitest's transform, so
// both @/services/redis.service and @/app (which imports it transitively)
// see the mocked getEnv from the moment they're first evaluated.
vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    // Port 1 is unassigned; nothing answers on it, so every connection
    // attempt fails immediately (ECONNREFUSED) rather than timing out at
    // the TCP level — that keeps this test fast while still exercising
    // the "unreachable" path end to end.
    getEnv: () => ({ ...actual.getEnv(), REDIS_URL: 'redis://127.0.0.1:1' }),
  }
})

describe('redis unreachable', () => {
  afterAll(async () => {
    await closeRedis()
  })

  it('isRedisReachable() resolves false within a few seconds instead of hanging', async () => {
    const startedAt = Date.now()
    await expect(isRedisReachable()).resolves.toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(8000)
  }, 10_000)

  it('starts a fresh connect after a failed one, instead of handing back the cached failure', async () => {
    vi.mocked(createClient).mockClear()
    await expect(getRedis()).rejects.toThrow()
    await expect(getRedis()).rejects.toThrow()
    expect(createClient).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('GET /health/ready returns 503 with checks.redis false', async () => {
    const app = createApp()
    const response = await request(app).get('/health/ready')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ status: 'not-ready', checks: { redis: false } })
  }, 10_000)
})
