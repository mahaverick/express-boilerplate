/**
 * @file A real account-deletion Worker picks a due-soon-alert job off the
 * real Redis and runs it with the real clock, and fails an unknown job name
 * for good on its first attempt through `recordPermanentFailure`. The run's
 * alerts are asserted in tests/integration/jobs/account-deletion.job.test.ts
 * with a fixed clock; here it is asserted only as a job that completes.
 */
import { afterAll, describe, expect, it, vi } from 'vite-plus/test'
import { ACCOUNT_DELETION_DUE_SOON_JOB } from '@/jobs/account-deletion.job'
import { logger } from '@/services/logger.service'
import {
  addJob,
  closeQueue,
  getAccountDeletionQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { startAccountDeletionWorker } from '@/workers/account-deletion.worker'
import { waitForJobSettled, waitForLoggedCall } from '../../helpers/queue-jobs'

describe('account-deletion.worker', () => {
  const worker = startAccountDeletionWorker()

  afterAll(async () => {
    await worker.close()
    await getAccountDeletionQueue().obliterate({ force: true })
    await getNotificationQueue().obliterate({ force: true })
    await getEmailQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('runs a queued due-soon-alert job to completion', async () => {
    const job = await addJob(
      getAccountDeletionQueue(),
      ACCOUNT_DELETION_DUE_SOON_JOB,
      {},
      { attempts: 1 }
    )
    if (!job.id) throw new Error('expected addJob to assign a job id')
    await expect(waitForJobSettled(worker, getAccountDeletionQueue(), job.id)).resolves.toBe(
      'completed'
    )
  })

  it('logs an unknown job name as a permanent failure on its first attempt', async () => {
    const loggerError = vi.spyOn(logger, 'error')

    try {
      const job = await addJob(getAccountDeletionQueue(), 'no-such-job', {}, { attempts: 3 })
      if (!job.id) throw new Error('expected addJob to assign a job id')
      const jobId = job.id

      await waitForLoggedCall(
        loggerError,
        (message, meta) => message === 'job failed permanently' && meta?.jobId === jobId,
        10_000
      )
      expect(loggerError).toHaveBeenCalledWith(
        'job failed permanently',
        expect.objectContaining({
          queue: 'account-deletion',
          jobId,
          name: 'no-such-job',
          attemptsMade: 1,
        })
      )
    } finally {
      loggerError.mockRestore()
    }
  })
})
