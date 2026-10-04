/**
 * @file `reportFinalJobFailure` on plain stand-ins for BullMQ's Job: only
 * the attempt after which BullMQ will not retry is reported, with the queue,
 * name and attempt count and never the job's data. The real Worker path is
 * tests/integration/workers/job-failure-reporting.test.ts.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportFinalJobFailure } from '@/jobs/job-failure.job'
import { reportError } from '@/services/errors/error-reporter.service'

vi.mock('@/services/errors/error-reporter.service', () => ({
  reportError: vi.fn(() => 'error-id'),
}))

/**
 * A stand-in Job with the fields the helper reads, and data it must never send.
 * @param attemptsMade - Attempts made, the failed one included.
 * @param attempts - The job's `attempts` option, if set.
 * @returns The fake.
 */
function fakeJob(attemptsMade: number, attempts?: number): Job {
  return {
    id: 'job-1',
    name: 'password_reset',
    attemptsMade,
    opts: attempts === undefined ? {} : { attempts },
    data: { to: 'secret-recipient@example.test', resetUrl: 'https://x.test/?token=abc' },
  } as unknown as Job
}

describe('reportFinalJobFailure', () => {
  afterEach(() => {
    vi.mocked(reportError).mockClear()
  })

  it.each([
    [1, 3],
    [2, 3],
  ])('does not report attempt %i of %i', (made, attempts) => {
    reportFinalJobFailure('email', fakeJob(made, attempts), new Error('smtp down'))

    expect(reportError).not.toHaveBeenCalled()
  })

  it('reports attempt 3 of 3 once, with the queue, name and attempts and no job data', () => {
    const error = new Error('smtp down')

    reportFinalJobFailure('email', fakeJob(3, 3), error)

    expect(reportError).toHaveBeenCalledExactlyOnceWith(error, {
      capturePoint: 'job',
      handled: true,
      job: { queue: 'email', name: 'password_reset', attemptsMade: 3 },
    })
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain('secret-recipient')
  })

  it('reports a job with no attempts option on its first failure', () => {
    reportFinalJobFailure('analytics', fakeJob(1), new Error('drain failed'))

    expect(reportError).toHaveBeenCalledOnce()
  })

  it('reports an UnrecoverableError on its first attempt, since BullMQ will not retry it', () => {
    reportFinalJobFailure('maintenance', fakeJob(1, 3), new UnrecoverableError('unknown job'))

    expect(reportError).toHaveBeenCalledOnce()
  })

  it('does not report when BullMQ could not load the job', () => {
    reportFinalJobFailure('email', undefined, new Error('lost'))

    expect(reportError).not.toHaveBeenCalled()
  })
})
