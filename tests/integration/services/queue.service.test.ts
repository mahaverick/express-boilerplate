/**
 * @file Integration test against the real Redis started by docker-compose,
 * the reachable-Redis counterpart to `queue-unreachable.service.test.ts`. It
 * follows `redis.service.test.ts`'s "reachable, then closed" order: the
 * "closed" assertions run last, because `closeQueue()` is permanent for the
 * module. Jobs go under this worker's own `REDIS_KEY_PREFIX`
 * (`tests/helpers/setup-global.ts` sets `test-w${VITEST_POOL_ID}`), so they
 * never collide with another vitest worker's keyspace.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  addJob,
  closeQueue,
  getAnalyticsQueue,
  getEmailQueue,
  getQueueConnection,
  isQueueReachable,
  setWorkersFailed,
} from '@/services/queue.service'

describe('queue.service', () => {
  afterAll(async () => {
    await closeQueue()
  })

  it('answers a ping', async () => {
    expect(await isQueueReachable()).toBe(true)
  })

  it('getEmailQueue() returns the same memoised instance on repeated calls', () => {
    expect(getEmailQueue()).toBe(getEmailQueue())
  })

  it('getAnalyticsQueue() returns the same memoised "analytics" queue on repeated calls', () => {
    expect(getAnalyticsQueue()).toBe(getAnalyticsQueue())
    expect(getAnalyticsQueue().name).toBe('analytics')
  })

  it('addJob() enqueues onto the given queue and returns a job carrying the same name and data', async () => {
    const job = await addJob(getEmailQueue(), 'welcome', { to: 'new-user@example.com' })
    expect(job.name).toBe('welcome')
    expect(job.data).toEqual({ to: 'new-user@example.com' })
    /**
     * The job is real, not a stub: it is stored under this worker's prefix and
     * fetchable by id. `job.id` is typed optional because BullMQ accepts
     * caller-supplied ids, but this call passed none, so BullMQ assigned one;
     * the guard narrows it instead of asserting with `!`.
     */
    if (!job.id) throw new Error('expected addJob() to assign a job id')
    expect(await getEmailQueue().getJob(job.id)).toMatchObject({ name: 'welcome' })
  })

  it('reports unreachable while the Workers have failed to start, and reachable once they run', async () => {
    setWorkersFailed(true)
    expect(await isQueueReachable()).toBe(false)
    setWorkersFailed(false)
    expect(await isQueueReachable()).toBe(true)
  })

  /**
   * `getQueueConnection()` and the queue getters connect lazily, so without
   * an explicit "closed" state a call after `closeQueue()` would open a
   * connection (and a Queue) and report healthy, as in the matching test
   * in `redis.service.test.ts`. Must run after every test above that still
   * needs a working connection or queue.
   */
  it('reports unreachable, without reconnecting, once closed', async () => {
    expect(await isQueueReachable()).toBe(true)
    /**
     * Remove every job this file, or an earlier run against the shared compose
     * Redis, left under this worker's prefix. It runs before `closeQueue()`
     * because it needs the open connection, and so that a Worker in another
     * test file does not pick up the `welcome` probe job on its first start
     * and process it as a real enqueue.
     */
    await getEmailQueue().obliterate({ force: true })
    await closeQueue()
    expect(await isQueueReachable()).toBe(false)
  })

  it('rejects a reconnect attempt once closed', () => {
    expect(() => getQueueConnection()).toThrow(/closed/)
  })

  it('is safe to close twice', async () => {
    await closeQueue()
    await expect(closeQueue()).resolves.toBeUndefined()
  })
})
