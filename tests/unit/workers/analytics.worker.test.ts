/**
 * @file processAnalyticsJob's decisions, with the drain mocked. The real
 * Worker runs in tests/integration/workers/analytics.worker.test.ts.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { processAnalyticsJob } from '@/workers/analytics.worker'

vi.mock('@/services/analytics/analytics-drain.service', () => ({ drainAnalyticsOutbox: vi.fn() }))

/**
 * A stand-in for an analytics Job; the processor reads only its name.
 * @param name - The job name.
 * @returns The fake, typed as a Job.
 */
function jobNamed(name: string): Job {
  return { name } as unknown as Job
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('processAnalyticsJob', () => {
  it('drains the outbox for an analytics-drain job', async () => {
    vi.mocked(drainAnalyticsOutbox).mockResolvedValue({
      sent: 2,
      retried: 0,
      rejected: 0,
      dropped: 0,
    })
    await expect(processAnalyticsJob(jobNamed('analytics-drain'))).resolves.toBeUndefined()
    expect(drainAnalyticsOutbox).toHaveBeenCalledOnce()
    expect(drainAnalyticsOutbox).toHaveBeenCalledWith()
  })

  it('fails the job when the drain throws, so the failure is logged', async () => {
    vi.mocked(drainAnalyticsOutbox).mockRejectedValue(new Error('database unreachable'))
    await expect(processAnalyticsJob(jobNamed('analytics-drain'))).rejects.toThrow(
      'database unreachable'
    )
  })

  it('refuses an unknown job name without a retry', async () => {
    await expect(processAnalyticsJob(jobNamed('something-else'))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(drainAnalyticsOutbox).not.toHaveBeenCalled()
  })
})
