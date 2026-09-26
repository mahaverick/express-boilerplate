// tests/unit/workers/maintenance.worker.test.ts
//
// processMaintenanceJob's decisions, with the purge mocked. The real Worker
// runs in tests/integration/workers/maintenance.worker.test.ts.
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRetentionPurge } from '@/services/retention.service'
import { processMaintenanceJob } from '@/workers/maintenance.worker'

vi.mock('@/services/retention.service', () => ({ runRetentionPurge: vi.fn() }))

/**
 * A stand-in for a maintenance Job; the processor reads only its name.
 * @param name - The job name.
 * @returns The fake, typed as a Job.
 */
function jobNamed(name: string): Job {
  return { name } as unknown as Job
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('processMaintenanceJob', () => {
  it('runs the retention purge for a retention-purge job', async () => {
    vi.mocked(runRetentionPurge).mockResolvedValue([{ table: 'email_logs', deleted: 3 }])
    await expect(processMaintenanceJob(jobNamed('retention-purge'))).resolves.toBeUndefined()
    expect(runRetentionPurge).toHaveBeenCalledOnce()
    expect(runRetentionPurge).toHaveBeenCalledWith()
  })

  it('fails the job, naming every failed rule, after all rules have run', async () => {
    vi.mocked(runRetentionPurge).mockResolvedValue([
      { table: 'user_tokens', deleted: 0, error: new Error('a') },
      { table: 'email_logs', deleted: 2 },
      { table: 'audit_logs', deleted: 0, error: new Error('b') },
    ])
    await expect(processMaintenanceJob(jobNamed('retention-purge'))).rejects.toThrow(
      'Retention purge failed for user_tokens, audit_logs'
    )
  })

  it('refuses an unknown job name without a retry', async () => {
    await expect(processMaintenanceJob(jobNamed('something-else'))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(runRetentionPurge).not.toHaveBeenCalled()
  })
})
