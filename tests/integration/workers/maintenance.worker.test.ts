// tests/integration/workers/maintenance.worker.test.ts
//
// A real maintenance Worker picks a retention-purge job off the real Redis
// and runs it against this worker's Postgres, with the schema's default
// windows and the real clock. No test file leaves rows older than those
// windows, so the run deletes nothing another file owns.
import type { Job, Worker } from 'bullmq'
import { afterAll, describe, expect, it } from 'vitest'
import { RETENTION_PURGE_JOB } from '@/jobs/maintenance.job'
import { addJob, closeQueue, getMaintenanceQueue } from '@/services/queue.service'
import { startMaintenanceWorker } from '@/workers/maintenance.worker'

/**
 * Wait for one job id to settle on `worker`.
 * @param worker - The running maintenance Worker.
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

describe('maintenance.worker', () => {
  const worker = startMaintenanceWorker()

  afterAll(async () => {
    await worker.close()
    await getMaintenanceQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('runs a queued retention-purge job to completion', async () => {
    const job = await addJob(getMaintenanceQueue(), RETENTION_PURGE_JOB, {}, { attempts: 1 })
    if (!job.id) throw new Error('expected addJob to assign a job id')
    await expect(waitForJobSettled(worker, job.id)).resolves.toBe('completed')
  }, 15_000)
})
