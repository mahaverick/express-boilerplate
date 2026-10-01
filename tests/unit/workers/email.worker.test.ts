/**
 * @file Pure-logic coverage of processEmailJob — the message lookup, the
 * suppression skip, the tracked send and the retry decision — with
 * sendMail and the email-message service mocked. Starting a real
 * Worker/Redis/Postgres belongs to tests/integration/workers/email.worker.test.ts.
 */
import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@/database/models/email-message.model'
import type { EmailJobData } from '@/jobs/email.job'
import * as emailMessageService from '@/services/email-message.service'
import { logger } from '@/services/logger.service'
import * as mailerService from '@/services/mailer.service'
import { processEmailJob } from '@/workers/email.worker'

vi.mock('@/services/mailer.service', () => ({
  sendMail: vi.fn(),
}))

vi.mock('@/services/email-message.service', () => ({
  createQueuedMessage: vi.fn(),
  findMessage: vi.fn(),
  isRecipientSuppressed: vi.fn(),
  markMessageSent: vi.fn(),
  markMessageSuppressed: vi.fn(),
}))

const MESSAGE_ID = '0190a000-0000-7000-8000-000000000001'

/**
 * The message row the mocked service hands back.
 * @param overrides - Fields to change.
 * @returns A queued message.
 */
function messageRow(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: MESSAGE_ID,
    recipient: 'user@example.com',
    templateKey: 'email_verification',
    userId: 'user-123',
    // eslint-disable-next-line unicorn/no-null -- a nullable column's value
    tenantId: null,
    // eslint-disable-next-line unicorn/no-null -- a nullable column's value
    invitationId: null,
    linkApp: 'web',
    senderClass: 'transactional',
    messageIdHeader: `<${MESSAGE_ID}@mail.example.com>`,
    // eslint-disable-next-line unicorn/no-null -- a nullable column's value
    jobKey: null,
    variables: { firstName: 'Ada', appName: 'Test' },
    status: 'queued',
    // eslint-disable-next-line unicorn/no-null -- a nullable column's value
    failureOrigin: null,
    statusUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    // eslint-disable-next-line unicorn/no-null -- a nullable column's value
    resentFromId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

/**
 * The payload of a job queued before tracking: no `messageId`.
 * @returns The job data.
 */
function untrackedData(): EmailJobData {
  return {
    to: 'user@example.com',
    templateKey: 'email_verification',
    variables: {
      firstName: 'Ada',
      verificationUrl: 'https://example.com/verify?token=abc',
      appName: 'Test',
    },
    userId: 'user-123',
  }
}

/**
 * The payload of a job `addEmailJob` queued: tracked by `MESSAGE_ID`.
 * @returns The job data.
 */
function trackedData(): EmailJobData {
  return { ...untrackedData(), messageId: MESSAGE_ID }
}

/**
 * A minimal stand-in for a BullMQ `Job<EmailJobData>` — only what
 * `processEmailJob` reads (`id`, `timestamp`, `data`, `updateData`). Cast
 * via `unknown`: a deliberately partial object standing in for the real
 * `Job` class BullMQ constructs.
 * @param data - The job's payload; a tracked one by default.
 * @param updateData - The job's `updateData`.
 * @returns A fake job for processEmailJob to process.
 */
function mockJob(
  data: EmailJobData = trackedData(),
  updateData: (data: unknown) => Promise<void> = () => Promise.resolve()
): Job<EmailJobData> {
  return {
    id: 'test-job-1',
    timestamp: 1_767_225_600_000,
    updateData,
    data,
  } as unknown as Job<EmailJobData>
}

describe('processEmailJob', () => {
  // This project's vitest config sets neither restoreMocks nor mockReset, so a mockResolvedValue set by one test would otherwise leak into the next.
  beforeEach(() => {
    vi.mocked(mailerService.sendMail).mockReset()
    vi.mocked(emailMessageService.findMessage).mockReset().mockResolvedValue(messageRow())
    vi.mocked(emailMessageService.createQueuedMessage).mockReset().mockResolvedValue(messageRow())
    vi.mocked(emailMessageService.isRecipientSuppressed).mockReset().mockResolvedValue(false)
    vi.mocked(emailMessageService.markMessageSent).mockReset().mockResolvedValue()
    vi.mocked(emailMessageService.markMessageSuppressed).mockReset().mockResolvedValue()
  })

  it("sends with the message's id and Message-ID header, then records sent", async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    await expect(processEmailJob(mockJob())).resolves.toBeUndefined()
    expect(mailerService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com', templateKey: 'email_verification' }),
      { messageId: MESSAGE_ID, messageIdHeader: `<${MESSAGE_ID}@mail.example.com>` }
    )
    expect(emailMessageService.markMessageSent).toHaveBeenCalledWith(MESSAGE_ID)
  })

  it('throws when sendMail returns failed so BullMQ retries, and records nothing', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(/Email job/)
    expect(emailMessageService.markMessageSent).not.toHaveBeenCalled()
  })

  it('does not include the recipient address in the thrown error message', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(
      expect.not.stringContaining('user@example.com')
    )
  })

  it('includes the job id and templateKey in the thrown error, for operator triage', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob())).rejects.toThrow(/test-job-1.*email_verification/)
  })

  it('completes without retrying when recording sent fails: a retry would send the email twice', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    vi.mocked(emailMessageService.markMessageSent).mockRejectedValue(new Error('db down'))
    await expect(processEmailJob(mockJob())).resolves.toBeUndefined()
  })

  it('marks a suppressed recipient suppressed and sends nothing', async () => {
    vi.mocked(emailMessageService.isRecipientSuppressed).mockResolvedValue(true)
    await expect(processEmailJob(mockJob())).resolves.toBeUndefined()
    expect(emailMessageService.isRecipientSuppressed).toHaveBeenCalledWith('user@example.com')
    expect(emailMessageService.markMessageSuppressed).toHaveBeenCalledWith(MESSAGE_ID)
    expect(mailerService.sendMail).not.toHaveBeenCalled()
    expect(emailMessageService.markMessageSent).not.toHaveBeenCalled()
  })

  it('sends nothing when the message row is gone (purged since the job was queued)', async () => {
    vi.mocked(emailMessageService.findMessage).mockResolvedValue(undefined)
    await expect(processEmailJob(mockJob())).resolves.toBeUndefined()
    expect(mailerService.sendMail).not.toHaveBeenCalled()
  })

  it('creates the row for a job queued without one, keyed so its retries reuse it', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    const updateData = vi.fn((_data: unknown) => Promise.resolve())
    const job = mockJob(untrackedData(), updateData)

    await processEmailJob(job)

    expect(emailMessageService.findMessage).not.toHaveBeenCalled()
    expect(emailMessageService.createQueuedMessage).toHaveBeenCalledWith(job.data, 'user-123', {
      jobKey: 'email-job-test-job-1-1767225600000',
    })
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({ messageId: MESSAGE_ID }))
    expect(mailerService.sendMail).toHaveBeenCalledWith(expect.anything(), {
      messageId: MESSAGE_ID,
      messageIdHeader: `<${MESSAGE_ID}@mail.example.com>`,
    })
  })

  it('still sends when storing the new message id on the job fails', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    const job = mockJob(untrackedData(), () =>
      Promise.reject(new Error('Missing key for job test-job-1'))
    )

    await expect(processEmailJob(job)).resolves.toBeUndefined()
    expect(mailerService.sendMail).toHaveBeenCalled()
  })

  it('fails without the recipient address, and sends nothing, when a lookup before the send throws', async () => {
    vi.mocked(emailMessageService.isRecipientSuppressed).mockRejectedValue(
      new Error('query failed, params: user@example.com')
    )
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {
      // Only the call is asserted.
    })
    try {
      const rejected = expect(processEmailJob(mockJob())).rejects
      await rejected.toThrow(expect.not.stringContaining('user@example.com'))
      await rejected.toThrow(
        /Email job test-job-1 failed before sending, for template email_verification/
      )
      expect(mailerService.sendMail).not.toHaveBeenCalled()
      expect(loggerError).toHaveBeenCalledWith(
        'Email job failed before sending',
        expect.objectContaining({ jobId: 'test-job-1' })
      )
    } finally {
      loggerError.mockRestore()
    }
  })
})
