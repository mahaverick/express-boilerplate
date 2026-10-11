/**
 * @file Confirms `isRedisReachable()` (and therefore `GET /health/ready`)
 * answers false, and `getRedis()` rejects, instead of hanging when Redis is
 * unreachable. Without `redis.service.ts`'s bounded `reconnectStrategy`, each
 * `getRedis()` waits out `REDIS_CONNECT_TIMEOUT_MS`, so the second test fails
 * by timing out rather than by a mismatched assertion. Its own file because
 * it mocks `getEnv()` to point `REDIS_URL` at a dead port for every test in
 * it; each test file runs in its own process, so that mock reaches no test
 * that needs the real compose-stack Redis.
 */
import { createClient } from 'redis'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { closeRedis, getRedis, isRedisReachable } from '@/services/redis.service'
import { request } from '../../helpers/request'

// Wrapped, not replaced: counts how many clients getRedis() creates.
vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>()
  return { ...actual, createClient: vi.fn(actual.createClient) }
})

/**
 * `vi.mock` is hoisted above the imports, so `@/services/redis.service` and
 * `@/app`, which imports it, see the mocked `getEnv` from their first evaluation.
 */
vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    // Port 1 is unassigned, so every connection attempt fails immediately (ECONNREFUSED) instead of timing out at the TCP level.
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
    // The claim: it gives up rather than waiting on Redis. The bound is far above REDIS_REQUEST_DEADLINE_MS, the longest isRedisReachable waits.
    expect(Date.now() - startedAt).toBeLessThan(8000)
  }, 10_000)

  it('starts a fresh connect after a failed one, instead of handing back the cached failure', async () => {
    // The readiness probe above answers at its deadline, before its connect has failed: let that one finish first.
    await expect(getRedis()).rejects.toThrow()
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
