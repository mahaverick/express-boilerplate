/**
 * @file Pure-logic coverage of processNotificationJob's channel fan-out and
 * retry decision, with both repositories' prototype methods spied on and
 * `addEmailJob` mocked. Starting a real Worker/Redis/Postgres belongs to
 * tests/integration/workers/notification.worker.test.ts.
 */
import type { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test'
import type { NewNotification, Notification } from '@/database/models/notification.model'
import * as emailJob from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import * as notificationEmitter from '@/services/notification-emitter.service'
import { emailJobIdFor, processNotificationJob } from '@/workers/notification.worker'

vi.mock('@/jobs/email.job', () => ({
  addEmailJob: vi.fn(),
}))

/**
 * `emitNotification` (notification-emitter.service.ts) is a plain exported
 * function, not a class method, so there is no prototype for `vi.spyOn` to
 * reach; it is mocked at the module level instead, as `addEmailJob` is above.
 */
vi.mock('@/services/notification-emitter.service', () => ({
  emitNotification: vi.fn(),
}))

/**
 * A minimal stand-in for a BullMQ `Job<NotificationJobData>`, with only the
 * properties `processNotificationJob` reads (`id`, `timestamp`, `data`).
 * `overrides` replaces fields of the default job data. Same shape and
 * reasoning as `mockJob` in email.worker.test.ts.
 */
function mockJob(overrides: Partial<NotificationJobData> = {}): Job<NotificationJobData> {
  return {
    id: 'test-notification-job-1',
    timestamp: 1_767_225_600_000,
    data: {
      userId: 'user-123',
      type: 'maintenance_mode_changed',
      title: 'Maintenance mode changed',
      body: 'Customers can only read until maintenance ends.',
      ...overrides,
    },
  } as unknown as Job<NotificationJobData>
}

const EXPECTED_DEDUPE_KEY = 'notification-job-test-notification-job-1-1767225600000'
const EXPECTED_EMAIL_JOB_ID = 'notification-email-test-notification-job-1-1767225600000'

/**
 * The row `NotificationRepository.createOnce` resolves with once
 * `insertSpy.mockResolvedValue(...)` is set up. Only its shape matters to
 * these tests, never its values, so every test shares this one fixture rather
 * than repeating the full row literal.
 *
 * `metadata`, `readAt` and `dedupeKey` are `null` here, not `undefined`:
 * `Notification` (notification.model.ts) types them as `T | null` (nullable
 * database columns), so `undefined` would not satisfy the type these tests
 * stub.
 */
const mockNotificationRow: Notification = {
  id: 'notification-1',
  userId: 'user-123',
  type: 'maintenance_mode_changed',
  title: 'Maintenance mode changed',
  body: 'body',
  metadata: null,
  readAt: null,
  dedupeKey: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

/**
 * A valid `maintenance_mode_changed` `MailMessage` to `to`. Every test that
 * needs an `email` payload on the job shares it, rather than repeating the
 * discriminated union's full shape.
 */
function maintenanceMessage(to: string): MailMessage {
  return {
    to,
    templateKey: 'maintenance_mode_changed',
    variables: {
      firstName: 'Ada',
      appName: 'Test',
      mode: 'read_only',
      actorName: 'Grace',
      reason: 'Database upgrade',
      changedAt: '2026-10-06T10:42:00.000Z',
    },
  }
}

/**
 * `vi.spyOn(NotificationRepository.prototype, 'createOnce')` etc., not
 * `vi.mock('@/repositories/...')`: notification.worker.ts builds its own
 * module-private `notificationRepository`/`preferenceRepository` instances at
 * import time, so spying on the prototype reaches those instances with a plain
 * property assignment, with no module re-mocking or `vi.hoisted()` plumbing.
 * Importing the real repository classes does not touch Postgres:
 * `database.service.ts`'s `postgres(...)` client connects lazily on first
 * query, and no test here lets the real `createOnce`/`isChannelEnabled`
 * implementation run.
 */
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
      type: 'maintenance_mode_changed',
      title: 'Maintenance mode changed',
      body: 'Customers can only read until maintenance ends.',
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
      metadata: { templateKey: 'maintenance_mode_changed' },
    })

    await processNotificationJob(
      mockJob({
        metadata: {
          templateKey: 'maintenance_mode_changed',
          variables: { signInUrl: 'https://example.test/auth/link?token=super-secret-token' },
        },
      })
    )

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { templateKey: 'maintenance_mode_changed' } })
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

    const email = maintenanceMessage('user@example.com')

    await processNotificationJob(mockJob({ email }))

    expect(emailJob.addEmailJob).toHaveBeenCalledWith(email, 'user-123', {
      jobId: EXPECTED_EMAIL_JOB_ID,
    })
  })

  it("passes the job's emailContext to addEmailJob for the message row", async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(emailJob.addEmailJob).mockResolvedValue({ id: 'email-job-1' } as never)
    const email = maintenanceMessage('user@example.com')
    const emailContext = { linkApp: 'apex' as const, resentFromId: 'message-0' }

    await processNotificationJob(mockJob({ email, emailContext }))

    expect(emailJob.addEmailJob).toHaveBeenCalledWith(email, 'user-123', {
      jobId: EXPECTED_EMAIL_JOB_ID,
      context: emailContext,
    })
  })

  it('does not enqueue an email when the email channel is disabled', async () => {
    // in_app enabled (first call), email disabled (second call): processNotificationJob checks the in-app channel first.
    channelEnabledSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    insertSpy.mockResolvedValue(mockNotificationRow)

    const email = maintenanceMessage('user@example.com')

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
    const email = maintenanceMessage('user@example.com')

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

    await processNotificationJob(mockJob({ email: maintenanceMessage('user@example.com') }))

    const options = vi.mocked(emailJob.addEmailJob).mock.calls[0]?.[2]
    expect(options?.jobId).not.toContain(':')
  })

  it('passes the email jobId when the in_app channel is disabled', async () => {
    channelEnabledSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.mocked(emailJob.addEmailJob).mockResolvedValue({ id: 'email-job-1' } as never)
    const email = maintenanceMessage('user@example.com')

    await processNotificationJob(mockJob({ email }))

    expect(insertSpy).not.toHaveBeenCalled()
    expect(emailJob.addEmailJob).toHaveBeenCalledWith(email, 'user-123', {
      jobId: EXPECTED_EMAIL_JOB_ID,
    })
  })

  it('rejects a job with no id before enqueueing an email', async () => {
    channelEnabledSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const email = maintenanceMessage('user@example.com')
    const job = { ...mockJob({ email }), id: undefined } as unknown as Job<NotificationJobData>

    await expect(processNotificationJob(job)).rejects.toThrow('Notification job has no id')
    expect(emailJob.addEmailJob).not.toHaveBeenCalled()
  })

  it('does not throw when emitNotification itself throws — the insert already committed', async () => {
    channelEnabledSpy.mockResolvedValue(true)
    insertSpy.mockResolvedValue(mockNotificationRow)
    vi.mocked(notificationEmitter.emitNotification).mockImplementation(() => {
      throw new TypeError('Do not know how to serialize a BigInt')
    })
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {
      // No-op: only that the failure was logged, not printed, is asserted.
    })

    try {
      await expect(processNotificationJob(mockJob())).resolves.toBeUndefined()
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to serialise notification for live delivery',
        expect.objectContaining({ notificationId: mockNotificationRow.id })
      )
    } finally {
      loggerErrorSpy.mockRestore()
    }
  })
})

describe('emailJobIdFor', () => {
  it('is notification-email-<job id>-<job timestamp>, the id maintenance mode waits on', () => {
    expect(emailJobIdFor({ id: '42', timestamp: 1_791_266_648_853 })).toBe(
      'notification-email-42-1791266648853'
    )
  })
})
