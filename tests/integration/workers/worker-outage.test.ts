// tests/integration/workers/worker-outage.test.ts
//
// BullMQ Workers through a Redis outage, over the TCP proxy in
// tests/helpers/redis-proxy.ts. Its own file because it mocks getEnv()'s
// REDIS_URL, and because its first test needs a Worker connection that has
// never been ready. Runs under its own REDIS_KEY_PREFIX, so no other Worker can
// pick up its jobs.
import { randomUUID } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { gracefulShutdown, startServer } from '@/server'
import { resetLifecycleForTests } from '@/services/lifecycle.service'
import { addJob, closeQueue, getEmailQueue, isQueueReachable } from '@/services/queue.service'
import { startWorkers, type SupervisedWorkers } from '@/services/worker-supervisor.service'
import { withMutatedMethod } from '../../helpers/mutate'
import { isEventuallyTrue, RedisProxy, sleep } from '../../helpers/redis-proxy'

const target = vi.hoisted(() => ({ realUrl: '', proxyUrl: '', prefix: '' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  target.realUrl = actual.getEnv().REDIS_URL
  target.prefix = `${actual.getEnv().REDIS_KEY_PREFIX}:outage-${randomUUID()}`
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      REDIS_URL: target.proxyUrl,
      REDIS_KEY_PREFIX: target.prefix,
    }),
  }
})

// retryIfFailed and run are BullMQ internals, wrapped here to observe them.
type WorkerInternals = {
  retryIfFailed: (this: Worker, ...retryArguments: unknown[]) => Promise<unknown>
  run: (this: Worker) => Promise<void>
}
const workerPrototype = Worker.prototype as unknown as WorkerInternals
const originalRetryIfFailed = workerPrototype.retryIfFailed
const originalRun = workerPrototype.run

// A spinning Worker calls retryIfFailed without end; this many calls means it spins.
const SPIN_BOUND = 500

const proxy = new RedisProxy()
const observed: { retries: number; workers: Worker[]; running?: SupervisedWorkers } = {
  retries: 0,
  workers: [],
}

/**
 * Count the Worker's fetch retries; stop a spinning Worker so the test can still fail.
 * @param retryArguments - retryIfFailed's own arguments.
 * @returns What the real retryIfFailed returns.
 */
function countedRetryIfFailed(this: Worker, ...retryArguments: unknown[]): Promise<unknown> {
  observed.retries += 1
  if (observed.retries > SPIN_BOUND) void this.close(true)
  return originalRetryIfFailed.apply(this, retryArguments)
}

/**
 * Record every Worker that starts, so the test can check each one is closed.
 * @returns What the real run returns.
 */
function recordedRun(this: Worker): Promise<void> {
  observed.workers.push(this)
  return originalRun.call(this)
}

/**
 * How long a 50ms timer takes to fire: far longer means the event loop is starved.
 * @returns The elapsed milliseconds.
 */
async function timerDelay(): Promise<number> {
  const startedAt = Date.now()
  await sleep(50)
  return Date.now() - startedAt
}

/**
 * Enqueue one email job and wait for a Worker to take it.
 * @returns Whether a Worker picked it up within 5s.
 */
async function isJobProcessed(): Promise<boolean> {
  const job = await addJob(
    getEmailQueue(),
    'outage-probe',
    { to: 'outage@example.test' },
    { attempts: 1 }
  )
  return isEventuallyTrue(
    async () => ['active', 'completed', 'failed'].includes(await job.getState()),
    5000
  )
}

describe('Queue Workers through a Redis outage', () => {
  beforeAll(async () => {
    await proxy.start(new URL(target.realUrl))
    target.proxyUrl = proxy.urlFor(new URL(target.realUrl))
  })

  // A failed test must not leave the next one talking to a dead proxy.
  afterEach(() => {
    proxy.comeBack()
  })

  afterAll(async () => {
    await observed.running?.close()
    await closeQueue()
    proxy.close()
    resetLifecycleForTests()
    // Both queues' keys under this file's own prefix, so none are left in the shared Redis.
    for (const name of ['email', 'notification']) {
      const cleanup = new Queue(name, {
        connection: { url: target.realUrl },
        prefix: target.prefix,
      })
      await cleanup.obliterate({ force: true })
      await cleanup.close()
    }
  })

  // First: its Worker connection must never have been ready.
  it('starts Workers during a boot-time outage that process jobs once Redis returns, without spinning', async () => {
    proxy.goDown()
    await withMutatedMethod(workerPrototype, 'run', recordedRun, async () => {
      await withMutatedMethod(workerPrototype, 'retryIfFailed', countedRetryIfFailed, async () => {
        observed.running = startWorkers()
        // Past two pre-ready give-ups (about 1.2s each).
        await sleep(2500)
        expect(await timerDelay()).toBeLessThan(200)
        expect(observed.retries).toBeLessThan(50)
        expect(await isQueueReachable()).toBe(false)

        proxy.comeBack()
        expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
        expect(await isJobProcessed()).toBe(true)
      })
    })
  }, 20_000)

  it('keeps Workers responsive through an outage after they were ready, then processes jobs again', async () => {
    await withMutatedMethod(workerPrototype, 'retryIfFailed', countedRetryIfFailed, async () => {
      observed.retries = 0
      proxy.goDown()
      await sleep(100)
      expect(await timerDelay()).toBeLessThan(200)
      await sleep(1000)
      expect(observed.retries).toBeLessThan(20)

      proxy.comeBack()
      expect(await isEventuallyTrue(isQueueReachable, 5000)).toBe(true)
      expect(await isJobProcessed()).toBe(true)
    })
  }, 20_000)

  // Last: shutdown closes the queue module for the rest of the file.
  it('closes every Worker it started, rebuilt ones included, on graceful shutdown', async () => {
    expect(observed.workers.length).toBeGreaterThan(2)
    const server = startServer(0)
    await gracefulShutdown(server, observed.running)
    for (const worker of observed.workers) {
      expect(worker.closing).toBeDefined()
      expect(worker.isRunning()).toBe(false)
    }
    await Promise.all(observed.workers.map(async (worker) => worker.closing))
  }, 20_000)
})
