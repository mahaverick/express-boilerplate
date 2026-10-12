/**
 * @file Exercises `waitForJobSettled` against a real BullMQ queue and Worker,
 * including a job that settled before the wait started.
 */
import { randomUUID } from 'node:crypto'
import { Queue, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getQueueConnection } from '@/services/queue.service'
import { redisKey } from '@/services/redis.service'
import { deferred } from '../../helpers/lock-probe'
import { waitForJobSettled } from '../../helpers/queue-jobs'

const queueName = `settled-${randomUUID()}`

describe('waitForJobSettled', () => {
  let queue: Queue
  let worker: Worker
  const gate = deferred()

  beforeAll(() => {
    const connection = getQueueConnection()
    const prefix = redisKey('bull')
    queue = new Queue(queueName, { connection, prefix })
    worker = new Worker(
      queueName,
      async (job) => {
        if (job.name === 'hold') await gate.promise
        else if (job.name === 'fail') throw new Error('planned failure')
      },
      { connection, prefix, concurrency: 5 }
    )
  })

  afterAll(async () => {
    gate.resolve()
    await worker.close()
    await queue.obliterate({ force: true })
    await queue.close()
  })

  /**
   * Starts watching for the next job named `name` to settle, by either outcome, without using the helper under test. Call it before adding the job.
   * @returns The id of the job that settled.
   */
  function nextSettled(name: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      /**
       * Resolves the watch for the first settled job of that name.
       */
      const done = (job: { id?: string; name: string } | undefined): void => {
        if (job?.name !== name) return
        worker.off('completed', done)
        worker.off('failed', done)
        resolve(job.id)
      }
      worker.on('completed', done)
      worker.on('failed', done)
    })
  }

  it('resolves for a failed job that settled before the call', async () => {
    const settled = nextSettled('fail')
    const job = await queue.add('fail', {}, { attempts: 1, removeOnFail: { count: 10 } })
    await settled
    if (!job.id) throw new Error('expected a job id')

    await expect(waitForJobSettled(worker, queue, job.id)).resolves.toBe('failed')
  })

  it('resolves for a kept completed job that settled before the call', async () => {
    const settled = nextSettled('ok')
    const job = await queue.add('ok', {}, { removeOnComplete: false })
    await settled
    if (!job.id) throw new Error('expected a job id')

    await expect(waitForJobSettled(worker, queue, job.id)).resolves.toBe('completed')
  })

  it('resolves for a completed job that was removed before the call', async () => {
    const settled = nextSettled('ok')
    const job = await queue.add('ok', {}, { removeOnComplete: true })
    await settled
    if (!job.id) throw new Error('expected a job id')

    await expect(waitForJobSettled(worker, queue, job.id)).resolves.toBe('completed')
  })

  it('waits for a running job, ignores other jobs and detaches its listeners', async () => {
    const listenersBefore = worker.listenerCount('completed') + worker.listenerCount('failed')
    const held = await queue.add('hold', {})
    if (!held.id) throw new Error('expected a job id')
    const waiting = waitForJobSettled(worker, queue, held.id)

    const otherSettled = nextSettled('ok')
    await queue.add('ok', {}, { removeOnComplete: false })
    await otherSettled
    const raced = await Promise.race([waiting, Promise.resolve('pending' as const)])
    expect(raced).toBe('pending')

    gate.resolve()
    await expect(waiting).resolves.toBe('completed')
    expect(worker.listenerCount('completed') + worker.listenerCount('failed')).toBe(listenersBefore)
  })
})
