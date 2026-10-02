/**
 * @file A real analytics Worker picks an analytics-drain job off the real
 * Redis, drains this worker's Postgres outbox to the fake PostHog, and logs a
 * failed drain at warn only. Analytics is enabled for this file through a
 * mocked `getEnv()`.
 */
import type { Job, Worker } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_DRAIN_JOB } from '@/jobs/analytics.job'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { addJob, closeQueue, getAnalyticsQueue } from '@/services/queue.service'
import { startAnalyticsWorker } from '@/workers/analytics.worker'
import { startFakePosthog, type FakePosthog } from '../../helpers/fake-posthog'
import { withMutatedMethod } from '../../helpers/mutate'
import { waitForLoggedCall } from '../../helpers/queue-jobs'

const target = vi.hoisted(() => ({ host: 'http://127.0.0.1:1' }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      POSTHOG_PROJECT_KEY: 'phc_test_key_not_real',
      POSTHOG_HOST: target.host,
    }),
  }
})

/**
 * Wait for one job id to settle on `worker`.
 * @param worker - The running analytics Worker.
 * @param jobId - The job to wait for.
 * @returns Which event fired for it.
 */
function waitForJobSettled(worker: Worker, jobId: string): Promise<'completed' | 'failed'> {
  return new Promise((resolve) => {
    const onCompleted = (job: Job): void => {
      if (job.id !== jobId) return
      cleanup()
      resolve('completed')
    }
    const onFailed = (job: Job | undefined): void => {
      if (job?.id !== jobId) return
      cleanup()
      resolve('failed')
    }
    const cleanup = (): void => {
      worker.off('completed', onCompleted)
      worker.off('failed', onFailed)
    }
    worker.on('completed', onCompleted)
    worker.on('failed', onFailed)
  })
}

const state: { posthog?: FakePosthog; worker?: Worker } = {}

beforeAll(async () => {
  state.posthog = await startFakePosthog()
  target.host = state.posthog.url
  state.worker = startAnalyticsWorker()
})

beforeEach(async () => {
  await sql`delete from analytics_outbox`
})

afterAll(async () => {
  await state.worker?.close()
  await getAnalyticsQueue().obliterate({ force: true })
  await closeQueue()
  await sql`delete from analytics_outbox`
  await state.posthog?.close()
})

describe('analytics.worker', () => {
  it('runs a queued analytics-drain job: the outbox row reaches PostHog and is deleted', async () => {
    const { worker, posthog } = state
    if (!worker || !posthog) throw new Error('setup did not run')
    const [row] = await sql<{ id: string }[]>`
      insert into analytics_outbox (event, distinct_id, properties)
      values ('worker_probe', 'system', '{}'::jsonb) returning id`

    const job = await addJob(getAnalyticsQueue(), ANALYTICS_DRAIN_JOB, {}, { attempts: 1 })
    if (!job.id) throw new Error('expected addJob to assign a job id')
    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')

    expect(posthog.batches.flat().map((event) => event.uuid)).toContain(row?.id)
    expect(await sql`select id from analytics_outbox`).toHaveLength(0)
  }, 15_000)

  it('logs a failed drain at warn, never as a permanent failure', async () => {
    const { worker } = state
    if (!worker) throw new Error('setup did not run')
    const loggerWarn = vi.spyOn(logger, 'warn')
    const loggerError = vi.spyOn(logger, 'error')

    try {
      await withMutatedMethod(
        AnalyticsOutboxRepository.prototype,
        'claimBatch',
        () => Promise.reject(new Error('claim failed')),
        async () => {
          const job = await addJob(getAnalyticsQueue(), ANALYTICS_DRAIN_JOB, {}, { attempts: 1 })
          if (!job.id) throw new Error('expected addJob to assign a job id')
          const jobId = job.id

          await waitForLoggedCall(
            loggerWarn,
            (message, meta) => message === 'Analytics drain failed' && meta?.jobId === jobId,
            10_000
          )
          expect(loggerError).not.toHaveBeenCalledWith('job failed permanently', expect.anything())
        }
      )
    } finally {
      loggerWarn.mockRestore()
      loggerError.mockRestore()
    }
  }, 15_000)
})
