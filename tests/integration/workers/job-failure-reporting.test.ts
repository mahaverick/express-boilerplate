/**
 * @file A real notification Worker failing a job three times on the real
 * Redis: attempts 1 and 2 of 3 are retried and not reported, attempt 3 of 3
 * is reported once with the queue, job name and attempt count, and nothing
 * from the job's data, and the `job failed permanently` line carries its
 * errorId. The reporter is spied.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import * as reporter from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'
import { addJob, closeQueue, getNotificationQueue } from '@/services/queue.service'
import { startNotificationWorker } from '@/workers/notification.worker'
import { withMutatedMethod } from '../../helpers/mutate'
import { waitUntil } from '../../helpers/timing'

describe('final job failures reach error tracking', () => {
  const worker = startNotificationWorker()

  afterAll(async () => {
    await worker.close()
    await getNotificationQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('reports attempt 3 of 3 once, and neither attempt before it', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const report = vi.spyOn(reporter, 'reportError')
    const marker = `job-data-marker-${randomUUID()}`
    const reportsAtAttempt = new Map<number, number>()
    const onFailed = (job: Job | undefined): void => {
      if (job?.data && (job.data as NotificationJobData).title === marker) {
        reportsAtAttempt.set(job.attemptsMade, report.mock.calls.length)
      }
    }
    worker.on('failed', onFailed)

    try {
      await withMutatedMethod(
        NotificationPreferenceRepository.prototype,
        'isChannelEnabled',
        () => Promise.reject(new Error('preferences unavailable')),
        async () => {
          await addJob<NotificationJobData>(
            getNotificationQueue(),
            'notification',
            { userId: randomUUID(), type: 'verify_email', title: marker, body: marker },
            { attempts: 3 }
          )
          await waitUntil(() => reportsAtAttempt.has(3), {
            message: 'the third attempt failed',
            timeout: 15_000,
          })
        }
      )
    } finally {
      worker.off('failed', onFailed)
    }

    expect(Object.fromEntries(reportsAtAttempt)).toEqual({ 1: 0, 2: 0, 3: 1 })
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      capturePoint: 'job',
      handled: true,
      job: { queue: 'notification', name: 'notification', attemptsMade: 3 },
    })
    expect(JSON.stringify(report.mock.calls)).not.toContain(marker)
    // The permanent-failure line names the event the report queued.
    const errorId = report.mock.results[0]?.value as string
    await waitUntil(
      () => loggerError.mock.calls.some(([message]) => message === 'job failed permanently'),
      { message: 'the permanent failure was logged', timeout: 5000 }
    )
    expect(loggerError).toHaveBeenCalledWith(
      'job failed permanently',
      expect.objectContaining({ errorId })
    )
  }, 20_000)
})
