// tests/unit/jobs/job-failure.job.test.ts
//
// The failed-job rules on plain stand-ins for BullMQ's Job: which failure is
// the last, what scrubbing replaces, and what the one error line carries.
// The real Worker path is tests/integration/workers/*.worker.test.ts.
import { UnrecoverableError, type Job } from 'bullmq'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTerminalFailure,
  logPermanentFailure,
  recordPermanentFailure,
  scrubJobData,
} from '@/jobs/job-failure.job'
import { logger } from '@/services/logger.service'

interface FakeJobFields {
  attemptsMade: number
  attempts?: number
  data?: unknown
  updateData?: (data: unknown) => Promise<void>
}

/**
 * A stand-in for a BullMQ Job with only the fields job-failure.job.ts reads.
 * @param fields - Attempts made, the attempts option, data and updateData.
 * @returns The fake, typed as a Job.
 */
function fakeJob(fields: FakeJobFields): Job {
  return {
    id: 'job-1',
    name: 'password_reset',
    attemptsMade: fields.attemptsMade,
    opts: fields.attempts === undefined ? {} : { attempts: fields.attempts },
    data: fields.data ?? {},
    updateData: fields.updateData ?? vi.fn(() => Promise.resolve()),
  } as unknown as Job
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isTerminalFailure', () => {
  it('is false while attempts remain', () => {
    expect(isTerminalFailure(fakeJob({ attemptsMade: 1, attempts: 2 }), new Error('x'))).toBe(false)
  })

  it('is true once attemptsMade reaches the attempts option', () => {
    expect(isTerminalFailure(fakeJob({ attemptsMade: 2, attempts: 2 }), new Error('x'))).toBe(true)
  })

  it('treats a missing attempts option as one attempt, as BullMQ does', () => {
    expect(isTerminalFailure(fakeJob({ attemptsMade: 1 }), new Error('x'))).toBe(true)
  })

  it('is true on the first attempt for an UnrecoverableError', () => {
    const job = fakeJob({ attemptsMade: 1, attempts: 5 })
    expect(isTerminalFailure(job, new UnrecoverableError('stop'))).toBe(true)
  })

  it('matches UnrecoverableError by name too, as BullMQ does', () => {
    const error = new Error('stop')
    // Not `error.name = ...`: unicorn/no-error-property-assignment forbids
    // assigning a built-in Error property directly, including via
    // Object.assign. defineProperty reaches the same shape without
    // tripping that rule (same pattern as logger.service.test.ts).
    Object.defineProperty(error, 'name', { value: 'UnrecoverableError' })
    expect(isTerminalFailure(fakeJob({ attemptsMade: 1, attempts: 5 }), error)).toBe(true)
  })

  it('is false for a job BullMQ could not load', () => {
    expect(isTerminalFailure(undefined, new UnrecoverableError('stop'))).toBe(false)
  })
})

describe('scrubJobData', () => {
  it('redacts every key ending in Url or Token, at any depth, and keeps the rest', () => {
    const data = {
      userId: 'u1',
      templateKey: 'password_reset',
      variables: { firstName: 'Ada', resetUrl: 'https://x.test/r?token=secret' },
      email: { variables: { verificationUrl: 'https://x.test/v?token=secret', appName: 'App' } },
      list: [{ acceptUrl: 'https://x.test/a?token=secret', role: 'viewer' }],
      refreshToken: 'secret',
    }

    expect(scrubJobData(data)).toEqual({
      userId: 'u1',
      templateKey: 'password_reset',
      variables: { firstName: 'Ada', resetUrl: '[redacted]' },
      email: { variables: { verificationUrl: '[redacted]', appName: 'App' } },
      list: [{ acceptUrl: '[redacted]', role: 'viewer' }],
      refreshToken: '[redacted]',
    })
  })

  it('returns a copy and leaves its argument untouched', () => {
    const data = { variables: { resetUrl: 'https://x.test/r' } }
    const scrubbed = scrubJobData(data)
    expect(scrubbed).not.toBe(data)
    expect(data.variables.resetUrl).toBe('https://x.test/r')
  })

  it('passes scalars through', () => {
    expect(scrubJobData('plain')).toBe('plain')
    expect(scrubJobData(3)).toBe(3)
  })
})

describe('logPermanentFailure', () => {
  it('writes one error line with the email template and user', () => {
    const loggerError = vi.spyOn(logger, 'error')
    const error = new Error('Email job job-1 failed for template password_reset')
    const job = fakeJob({
      attemptsMade: 5,
      attempts: 5,
      data: { templateKey: 'password_reset', userId: 'u1', to: 'a@example.test' },
    })

    logPermanentFailure('email', job, error)

    expect(loggerError).toHaveBeenCalledOnce()
    expect(loggerError).toHaveBeenCalledWith('job failed permanently', {
      queue: 'email',
      jobId: 'job-1',
      name: 'password_reset',
      template: 'password_reset',
      userId: 'u1',
      attemptsMade: 5,
      reason: error,
    })
  })

  it("takes a notification job's template from its paired email, and omits it when there is none", () => {
    const loggerError = vi.spyOn(logger, 'error')
    const withEmail = fakeJob({
      attemptsMade: 3,
      data: { userId: 'u1', type: 'verify_email', email: { templateKey: 'email_verification' } },
    })
    const withoutEmail = fakeJob({ attemptsMade: 3, data: { userId: 'u1', type: 'verify_email' } })

    logPermanentFailure('notification', withEmail, new Error('x'))
    logPermanentFailure('notification', withoutEmail, new Error('x'))

    expect(loggerError.mock.calls[0]?.[1]).toMatchObject({ template: 'email_verification' })
    expect(loggerError.mock.calls[1]?.[1]).not.toHaveProperty('template')
  })
})

describe('recordPermanentFailure', () => {
  it('stores the scrubbed data, then logs', async () => {
    const order: string[] = []
    const updateData = vi.fn((data: unknown) => {
      order.push(`update ${JSON.stringify(data)}`)
      return Promise.resolve()
    })
    vi.spyOn(logger, 'error').mockImplementation((message) => {
      order.push(message)
    })
    const job = fakeJob({
      attemptsMade: 2,
      attempts: 2,
      data: { variables: { resetUrl: 'https://x.test' } },
      updateData,
    })

    await recordPermanentFailure('email', job, new Error('x'))

    expect(order).toEqual([
      'update {"variables":{"resetUrl":"[redacted]"}}',
      'job failed permanently',
    ])
  })

  it('never rejects: a failed scrub is logged, and the failure is still logged', async () => {
    const loggerError = vi.spyOn(logger, 'error')
    const job = fakeJob({
      attemptsMade: 2,
      attempts: 2,
      updateData: () => Promise.reject(new Error('Missing key for job job-1')),
    })

    await expect(recordPermanentFailure('email', job, new Error('x'))).resolves.toBeUndefined()

    expect(loggerError.mock.calls.map(([message]) => message)).toEqual([
      "Scrubbing a failed job's data failed",
      'job failed permanently',
    ])
  })
})
