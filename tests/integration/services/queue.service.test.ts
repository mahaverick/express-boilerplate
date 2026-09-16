// tests/integration/services/queue.service.test.ts
//
// Integration test against the real Redis started by docker-compose — the
// happy-path counterpart to queue-unreachable.service.test.ts. Modeled on
// redis.service.test.ts's own structure (same "reachable, then closed"
// ordering, for the same reason: getQueueConnection()/getEmailQueue()
// reconnect lazily, so the "closed" assertions must run last, after every
// test that still needs a working connection).
//
// Runs under this worker's own QUEUE_PREFIX (tests/helpers/setup-global.ts
// sets `bull:test-w${VITEST_POOL_ID}`), so jobs this file adds never
// collide with another vitest worker's keyspace.
import { afterAll, describe, expect, it } from 'vitest'
import {
  addJob,
  closeQueue,
  getEmailQueue,
  getQueueConnection,
  isQueueReachable,
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

  it('addJob() enqueues onto the given queue and returns a job carrying the same name and data', async () => {
    const job = await addJob(getEmailQueue(), 'welcome', { to: 'new-user@example.com' })
    expect(job.name).toBe('welcome')
    expect(job.data).toEqual({ to: 'new-user@example.com' })
    // The job is real, not a stub — it was actually written under this
    // worker's own prefix, addressable by id. `job.id` is typed optional
    // (BullMQ supports caller-supplied ids), but addJob() here never passed
    // one, so BullMQ always auto-assigns one — narrowed explicitly rather
    // than asserted with `!`.
    if (!job.id) throw new Error('expected addJob() to assign a job id')
    expect(await getEmailQueue().getJob(job.id)).toMatchObject({ name: 'welcome' })
  })

  // getQueueConnection()/getEmailQueue() reconnect lazily, so without an
  // explicit "closed" state a call issued after closeQueue() would silently
  // open a new connection (and a new Queue) and report healthy — exactly the
  // bug this test exists to pin down, same reasoning as
  // redis.service.test.ts's identical test for redis.service.ts. Must run
  // after every test above that still needs a working connection/queue.
  it('reports unreachable, without reconnecting, once closed', async () => {
    expect(await isQueueReachable()).toBe(true)
    // Clean up every job this file (and any earlier run against this same
    // shared compose Redis) left under this worker's prefix — before
    // closeQueue() below, while the connection is still open. Left in
    // place, Task 3's Worker would pick up this file's `welcome` probe job
    // on its very first start and process it as if a real caller had
    // enqueued it.
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
