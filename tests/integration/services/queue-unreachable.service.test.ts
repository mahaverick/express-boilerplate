// tests/integration/services/queue-unreachable.service.test.ts
//
// Isolated via vi.resetModules() + a dynamic import(), NOT vi.mock(getEnv)
// (contrast redis-unreachable.service.test.ts): queue.service.ts's own
// module-scope `state` is created once, on first import, so this file needs
// a genuinely fresh module instance — not merely a mocked getEnv layered
// over whatever instance another test file's module registry already holds
// — to guarantee REDIS_URL is wrong from this module's very first
// getQueueConnection() call.
//
// Same reasoning as redis-unreachable.service.test.ts's own header: before
// the bounded retryStrategy in queue.service.ts, ioredis's default
// retryStrategy retries forever and neither isQueueReachable() nor
// queue.add() would ever settle — this test fails by TIMING OUT, not a
// mismatched assertion, if that bound is ever removed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('queue unreachable', () => {
  // Captured before beforeAll overwrites it, so afterAll can put the real
  // per-worker REDIS_URL (from .env.test, via loadTestEnv()) back — process.env
  // persists across test FILES within one vitest worker (only the module
  // registry resets between files, per tests/helpers/setup-global.ts's own
  // comment), so leaving this overwritten would break REDIS_URL for every
  // later file in the same worker.
  const originalRedisUrl = process.env.REDIS_URL
  let queueService: typeof import('@/services/queue.service')

  beforeAll(async () => {
    // Port 1 is unassigned; nothing answers on it, so every connection
    // attempt fails immediately (ECONNREFUSED) rather than timing out at
    // the TCP level — same choice redis-unreachable.service.test.ts makes,
    // for the same reason: it keeps this test fast while still exercising
    // the "unreachable" path end to end.
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
    expect(Date.now() - startedAt).toBeLessThan(8000)
  }, 10_000)

  // BullMQ waits for the producer connection's first 'ready' before sending
  // this add(), so it only settles once the bounded pre-ready retryStrategy
  // gives up. That is the behaviour this test pins down: a Redis that is
  // unreachable at boot surfaces as a rejected enqueue, not a job silently
  // swallowed forever.
  it('getEmailQueue().add(...) eventually rejects once retries are exhausted', async () => {
    await expect(
      queueService.getEmailQueue().add('probe', { to: 'unreachable@example.com' })
    ).rejects.toThrow()
  }, 10_000)
})
