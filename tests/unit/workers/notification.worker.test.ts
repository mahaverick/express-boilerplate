// tests/unit/workers/notification.worker.test.ts
//
// Pure-logic coverage of processNotificationJob's channel fan-out and retry
// decision, with both repositories' prototype methods spied on and
// `addEmailJob` mocked — starting a real Worker/Redis/Postgres belongs to
// tests/integration/workers/notification.worker.test.ts, per this repo's
// own unit/integration split (CLAUDE.md).
//
// `vi.spyOn(NotificationRepository.prototype, 'createOnce')` etc., not
// `vi.mock('@/repositories/...')`: notification.worker.ts builds its own
// module-private `notificationRepository`/`preferenceRepository` instances
// at import time (CLAUDE.md's own "module-private instance of an exported
// repository class" shape) — spying on the prototype reaches that already-
// constructed instance with a plain property assignment, no module
// re-mocking or `vi.hoisted()` plumbing needed to get at it. Importing the
// real repository classes does not touch Postgres: `database.service.ts`'s
// `postgres(...)` client connects lazily on first query, and no test here
// ever lets the real `create`/`isChannelEnabled` implementation run.
import type { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NewNotification, Notification } from '@/database/models/notification.model'
import * as emailJob from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import * as notificationEmitter from '@/services/notification-emitter.service'
import { processNotificationJob } from '@/workers/notification.worker'

vi.mock('@/jobs/email.job', () => ({
  addEmailJob: vi.fn(),
}))

// `emitNotification` (notification-emitter.service.ts) is a plain exported
// function, not a class method — there is no prototype for
// `vi.spyOn(NotificationRepository.prototype, 'create')`'s own pattern to
// reach, so this is mocked at the module level instead, same as
// `addEmailJob` immediately above.
vi.mock('@/services/notification-emitter.service', () => ({
  emitNotification: vi.fn(),
}))

/**
 * A minimal stand-in for a BullMQ `Job<NotificationJobData>` — only the
 * properties `processNotificationJob` actually reads (`id`, `timestamp`,
 * `data`). Same shape and reasoning as email.worker.test.ts's own `mockJob`
 * helper.
 * @param overrides - Fields to override on the default job data.
 * @returns A fake job for processNotificationJob to process.
 */
function mockJob(overrides: Partial<NotificationJobData> = {}): Job<NotificationJobData> {
  return {
    id: 'test-notification-job-1',
    timestamp: 1_767_225_600_000,
    data: {
      userId: 'user-123',
      type: 'verify_email',
      title: 'Verify your email',
      body: 'Click the link to verify your email address.',
      ...overrides,
    },
  } as unknown as Job<NotificationJobData>
}

const EXPECTED_DEDUPE_KEY = 'notification-job-test-notification-job-1-1767225600000'
const EXPECTED_EMAIL_JOB_ID = 'notification-email-test-notification-job-1-1767225600000'

/**
 * The row `NotificationRepository.create` resolves with once
 * `insertSpy.mockResolvedValue(...)` is set up — only its shape matters to
 * these tests, never its actual values, so every test shares this one
 * fixture rather than repeating the full row literal.
 *
 * `metadata`/`readAt` are genuinely `null` here, not `undefined` —
 * `Notification` (notification.model.ts) types both as `T | null` (a real,
 * always-present nullable database column), so `undefined` would not even
 * satisfy the type these tests are stubbing.
 */
const mockNotificationRow: Notification = {
  id: 'notification-1',
  userId: 'user-123',
  type: 'verify_email',
  title: 'Verify your email',
  body: 'body',
  // eslint-disable-next-line unicorn/no-null -- Notification.metadata/readAt are `T | null` database columns; see this const's own comment.
  metadata: null,
  // eslint-disable-next-line unicorn/no-null -- see comment above.
  readAt: null,
  // eslint-disable-next-line unicorn/no-null -- see comment above.
  dedupeKey: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

/**
 * A real, valid `email_verification` `MailMessage` — every test that needs
 * an `email` payload on the job shares this one, rather than repeating the
 * discriminated union's full shape.
 * @param to - The recipient address.
 * @returns A `MailMessage` for the `email_verification` template.
 */
function emailVerificationMessage(to: string): MailMessage {
  return {
    to,
    templateKey: 'email_verification',
    variables: {
      firstName: 'Ada',
      verificationUrl: 'https://example.com/verify?token=abc',
      appName: 'Test',
    },
  }
}

describe('processNotificationJob', () => {
  let insertSpy: MockInstance<typeof NotificationRepository.prototype.createOnce>
  let channelEnabledSpy: MockInstance<
    typeof NotificationPreferenceRepository.prototype.isChannelEnabled
  >

  beforeEach(() => {
    insertSpy = vi.spyOn(NotificationRepository.prototype, 'createOnce')
    channelEnabledSpy = vi.spyOn(NotificationPreferenceRepository.prototype, 'isChannelEnabled')
    vi.mocked(emailJob.addEmailJob).mockReset()
    vi.mocked(notificationEmitter.emitNotification).mockReset()
  })

  afterEach(() => {
    insertSpy.mockRestore()
    channelEnabledSpy.mockRestore()
  })

  it('inserts an in-app row when the in_app channel is enabled', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)

    await processNotificationJob(mockJob())

    expect(insertSpy).toHaveBeenCalledWith({
      userId: 'user-123',
      type: 'verify_email',
      title: 'Verify your email',
      body: 'Click the link to verify your email address.',
      dedupeKey: EXPECTED_DEDUPE_KEY,
    })
  })

  it('publishes the inserted row to the notification emitter after the in-app insert succeeds', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)

    await processNotificationJob(mockJob())

    expect(notificationEmitter.emitNotification).toHaveBeenCalledWith(
      'user-123',
      mockNotificationRow
    )
  })

  it('does not publish to the notification emitter when the in_app channel is disabled', async () => {
    channelEnabledSpy.mockResolvedValue(false)

    await processNotificationJob(mockJob())

    expect(notificationEmitter.emitNotification).not.toHaveBeenCalled()
  })

  it('strips variables out of metadata before the in-app insert', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue({
      ...mockNotificationRow,
      metadata: { templateKey: 'email_verification' },
    })

    await processNotificationJob(
      mockJob({
        metadata: {
          templateKey: 'email_verification',
          variables: { verificationUrl: 'https://example.test/verify?token=super-secret-token' },
        },
      })
    )

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { templateKey: 'email_verification' } })
    )
    const [insertedRow] = insertSpy.mock.calls[0] as [NewNotification]
    expect(insertedRow.metadata).not.toHaveProperty('variables')
  })

  it('does not insert an in-app row when the in_app channel is disabled', async () => {
    channelEnabledSpy.mockResolvedValue(false)

    await processNotificationJob(mockJob())

    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('enqueues the paired email when the email channel is enabled and email is present', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(emailJob.addEmailJob).mockResolvedValue({ id: 'email-job-1' } as never)

    const email = emailVerificationMessage('user@example.com')

    await processNotificationJob(mockJob({ email }))

    expect(emailJob.addEmailJob).toHaveBeenCalledWith(email, 'user-123', {
      jobId: EXPECTED_EMAIL_JOB_ID,
    })
  })

  it('does not enqueue an email when the email channel is disabled', async () => {
    // in_app enabled (first call), email disabled (second call) — same
    // per-call sequencing `isChannelEnabled` is actually invoked in by
    // processNotificationJob: in-app is always checked first.
    channelEnabledSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    insertSpy.mockResolvedValue(mockNotificationRow)

    const email = emailVerificationMessage('user@example.com')

    await processNotificationJob(mockJob({ email }))

    expect(emailJob.addEmailJob).not.toHaveBeenCalled()
  })

  it('does not enqueue an email when no email payload is present on the job', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)

    await processNotificationJob(mockJob())

    expect(emailJob.addEmailJob).not.toHaveBeenCalled()
  })

  it('throws when the in-app insert fails, so BullMQ retries the whole job', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockRejectedValue(new Error('insert failed'))

    await expect(processNotificationJob(mockJob())).rejects.toThrow('insert failed')
  })

  it('rejects when the email enqueue fails, so BullMQ retries the job', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(emailJob.addEmailJob).mockRejectedValue(new Error('redis unavailable'))
    const email = emailVerificationMessage('user@example.com')

    await expect(processNotificationJob(mockJob({ email }))).rejects.toThrow('redis unavailable')
  })

  it('does not emit again when a retry finds the row already inserted', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValueOnce(mockNotificationRow).mockResolvedValueOnce(undefined)

    await processNotificationJob(mockJob())
    await processNotificationJob(mockJob())

    expect(insertSpy).toHaveBeenCalledTimes(2)
    expect(insertSpy.mock.calls[1]?.[0]).toMatchObject({ dedupeKey: EXPECTED_DEDUPE_KEY })
    expect(notificationEmitter.emitNotification).toHaveBeenCalledTimes(1)
  })

  it('never builds a BullMQ job id containing a colon, which BullMQ rejects', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(emailJob.addEmailJob).mockResolvedValue({ id: 'email-job-1' } as never)

    await processNotificationJob(mockJob({ email: emailVerificationMessage('user@example.com') }))

    const options = vi.mocked(emailJob.addEmailJob).mock.calls[0]?.[2]
    expect(options?.jobId).not.toContain(':')
  })

  it('passes the email jobId when the in_app channel is disabled', async () => {
    channelEnabledSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.mocked(emailJob.addEmailJob).mockResolvedValue({ id: 'email-job-1' } as never)
    const email = emailVerificationMessage('user@example.com')

    await processNotificationJob(mockJob({ email }))

    expect(insertSpy).not.toHaveBeenCalled()
    expect(emailJob.addEmailJob).toHaveBeenCalledWith(email, 'user-123', {
      jobId: EXPECTED_EMAIL_JOB_ID,
    })
  })

  it('rejects a job with no id before enqueueing an email', async () => {
    channelEnabledSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const email = emailVerificationMessage('user@example.com')
    const job = { ...mockJob({ email }), id: undefined } as unknown as Job<NotificationJobData>

    await expect(processNotificationJob(job)).rejects.toThrow('Notification job has no id')
    expect(emailJob.addEmailJob).not.toHaveBeenCalled()
  })

  it('does not throw when emitNotification itself throws — the insert already committed', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(notificationEmitter.emitNotification).mockImplementation(() => {
      throw new Error('a listener blew up')
    })
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {
      // No-op: only that the failure was logged, not printed, is asserted.
    })

    try {
      await expect(processNotificationJob(mockJob())).resolves.toBeUndefined()
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to publish notification to the SSE emitter',
        expect.objectContaining({ notificationId: mockNotificationRow.id })
      )
    } finally {
      loggerErrorSpy.mockRestore()
    }
  })
})
