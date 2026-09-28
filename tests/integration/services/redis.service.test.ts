/**
 * @file Integration test against the real Redis started by docker-compose.
 * No keys are written, so there is no cross-worker data-isolation risk here
 * (see `database.service.test.ts` for the equivalent Postgres note).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { closeRedis, getRedis, isRedisReachable } from '@/services/redis.service'

describe('redis.service', () => {
  afterAll(async () => {
    await closeRedis()
  })

  it('hands concurrent first callers one shared client', async () => {
    const [first, second] = await Promise.all([getRedis(), getRedis()])
    expect(first).toBe(second)
  })

  it('answers a ping', async () => {
    expect(await isRedisReachable()).toBe(true)
  })

  it('reports unhealthy when the client rejects', async () => {
    const client = await getRedis()
    vi.spyOn(client, 'ping').mockRejectedValueOnce(new Error('boom'))
    expect(await isRedisReachable()).toBe(false)
  })

  /**
   * `getRedis()` reconnects lazily, so without an explicit "closed" state a
   * ping issued after `closeRedis()` would silently open a new socket and
   * report healthy. `closeRedis()` marks the module permanently closed,
   * matching a real process shutting down, so this must run before any
   * later test in this file that still needs a working client.
   */
  it('reports unreachable, without reconnecting, once closed', async () => {
    expect(await isRedisReachable()).toBe(true)
    await closeRedis()
    expect(await isRedisReachable()).toBe(false)
  })

  it('rejects a reconnect attempt once closed', async () => {
    await expect(getRedis()).rejects.toThrow(/closed/)
  })

  it('is safe to close twice', async () => {
    await closeRedis()
    await expect(closeRedis()).resolves.toBeUndefined()
  })
})
