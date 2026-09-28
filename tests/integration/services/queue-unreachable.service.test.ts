/**
 * @file Confirms BullMQ's queue connections give up, instead of hanging or
 * retrying forever, when Redis is unreachable. Isolated via
 * `vi.resetModules()` plus a dynamic `import()`, not `vi.mock(getEnv)`
 * (contrast `redis-unreachable.service.test.ts`): `queue.service.ts`'s own
 * module-scope state is created once, on first import, so this file needs a
 * genuinely fresh module instance — not a mocked `getEnv` layered over
 * whatever instance another test file's module registry already holds — to
 * guarantee `REDIS_URL` is wrong from this module's very first
 * `getQueueConnection()` call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('queue unreachable', () => {
  /**
   * Captured before `beforeAll` overwrites it, so `afterAll` can put the
   * real per-worker `REDIS_URL` back. `process.env` persists across test
   * files within one vitest worker (only the module registry resets
   * between files), so leaving this overwritten would break `REDIS_URL`
   * for every later file in the same worker.
   */
  const originalRedisUrl = process.env.REDIS_URL
  let queueService: typeof import('@/services/queue.service')

  beforeAll(async () => {
    // Port 1 is unassigned, so every connection attempt fails immediately (ECONNREFUSED) instead of timing out at the TCP level.
    process.env.REDIS_URL = 'redis://127.0.0.1:1'
    vi.resetModules()
    queueService = await import('@/services/queue.service')
  })

  afterAll(async () => {
    await queueService.closeQueue()
    process.env.REDIS_URL = originalRedisUrl
  })

  it('isQueueReachable() resolves false within a few seconds instead of hanging', async () => {
    const startedAt = Date.now()
    await expect(queueService.isQueueReachable()).resolves.toBe(false)
    // The claim: it gives up rather than retrying forever. 10x the measured p99 (1303ms).
    expect(Date.now() - startedAt).toBeLessThan(14_000)
  }, 20_000)

  /**
   * BullMQ waits for the producer connection's first `'ready'` before
   * sending this `add()`, so it only settles once the bounded pre-ready
   * `retryStrategy` (`queue.service.ts`) gives up: a Redis that is
   * unreachable at boot surfaces as a rejected enqueue, not a job silently
   * swallowed forever.
   */
  it('getEmailQueue().add(...) eventually rejects once retries are exhausted', async () => {
    await expect(
      queueService.getEmailQueue().add('probe', { to: 'unreachable@example.com' })
    ).rejects.toThrow()
  }, 10_000)
})
