/**
 * @file processAnalyticsJob's decisions, with the drain, the deletion tick
 * and the analytics flag mocked. The real Worker runs in
 * tests/integration/workers/analytics.worker.test.ts.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { processAnalyticsDeletions } from '@/services/analytics/analytics-deletion.service'
import { drainAnalyticsOutbox } from '@/services/analytics/analytics-drain.service'
import { processAnalyticsJob } from '@/workers/analytics.worker'

vi.mock('@/services/analytics/analytics-drain.service', () => ({ drainAnalyticsOutbox: vi.fn() }))
vi.mock('@/services/analytics/analytics-deletion.service', () => ({
  processAnalyticsDeletions: vi.fn(),
}))
vi.mock('@/configs/analytics.config', () => ({ isAnalyticsEnabled: vi.fn(() => true) }))

/**
 * A stand-in for an analytics Job; the processor reads only its name.
 * @param name - The job name.
 * @returns The fake, typed as a Job.
 */
function jobNamed(name: string): Job {
  return { name } as unknown as Job
}

beforeEach(() => {
  vi.mocked(isAnalyticsEnabled).mockReturnValue(true)
})

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
    expect(processAnalyticsDeletions).not.toHaveBeenCalled()
  })

  it('skips the drain while analytics is off, as a schedule left in Redis from an earlier configuration', async () => {
    vi.mocked(isAnalyticsEnabled).mockReturnValue(false)
    await expect(processAnalyticsJob(jobNamed('analytics-drain'))).resolves.toBeUndefined()
    expect(drainAnalyticsOutbox).not.toHaveBeenCalled()
  })

  it('runs one deletion tick for an analytics-deletions job, whatever the analytics flag', async () => {
    vi.mocked(isAnalyticsEnabled).mockReturnValue(false)
    vi.mocked(processAnalyticsDeletions).mockResolvedValue({ deleted: 1, failed: 0 })
    await expect(processAnalyticsJob(jobNamed('analytics-deletions'))).resolves.toBeUndefined()
    expect(processAnalyticsDeletions).toHaveBeenCalledOnce()
    expect(processAnalyticsDeletions).toHaveBeenCalledWith()
    expect(drainAnalyticsOutbox).not.toHaveBeenCalled()
  })

  it('fails the job when the drain or the deletion tick throws, so the failure is logged', async () => {
    vi.mocked(drainAnalyticsOutbox).mockRejectedValue(new Error('database unreachable'))
    await expect(processAnalyticsJob(jobNamed('analytics-drain'))).rejects.toThrow(
      'database unreachable'
    )
    vi.mocked(processAnalyticsDeletions).mockRejectedValue(new Error('claim failed'))
    await expect(processAnalyticsJob(jobNamed('analytics-deletions'))).rejects.toThrow(
      'claim failed'
    )
  })

  it('refuses an unknown job name without a retry', async () => {
    await expect(processAnalyticsJob(jobNamed('something-else'))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(drainAnalyticsOutbox).not.toHaveBeenCalled()
    expect(processAnalyticsDeletions).not.toHaveBeenCalled()
  })
})
