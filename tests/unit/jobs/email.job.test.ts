/**
 * @file addEmailJob's ordering and failure handling, with the queue and the
 * email-message service mocked: the row comes first, its id rides on the
 * job, the context never reaches BullMQ, and a failed add marks the row and
 * still rejects. The real Redis and Postgres path is
 * tests/integration/jobs/email.job.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@/database/models/email-message.model'
import { addEmailJob, emailJobDefaults } from '@/jobs/email.job'
import * as emailMessageService from '@/services/email-message.service'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import * as queueService from '@/services/queue.service'

vi.mock('@/services/email-message.service', () => ({
  createQueuedMessage: vi.fn(),
  markMessageEnqueueFailed: vi.fn(),
}))

vi.mock('@/services/queue.service', () => ({
  addJob: vi.fn(),
  getEmailQueue: vi.fn(() => ({ name: 'email' })),
}))

const MESSAGE_ID = '0190a000-0000-7000-8000-000000000002'

const message: MailMessage = {
  to: 'user@example.com',
  templateKey: 'password_reset',
  variables: { firstName: 'Ada', resetUrl: 'https://example.com/r?token=abc', appName: 'Test' },
}

describe('addEmailJob', () => {
  beforeEach(() => {
    vi.mocked(emailMessageService.createQueuedMessage)
      .mockReset()
      .mockResolvedValue({ id: MESSAGE_ID } as EmailMessage)
    vi.mocked(emailMessageService.markMessageEnqueueFailed).mockReset().mockResolvedValue()
    vi.mocked(queueService.addJob)
      .mockReset()
      .mockResolvedValue({ id: 'job-1' } as never)
  })

  it('creates the message row, then enqueues the job carrying its id', async () => {
    const context = { linkApp: 'apex' as const, resentFromId: 'message-0' }
    await addEmailJob(message, 'user-1', { jobId: 'notification-email-7-1', context })

    expect(emailMessageService.createQueuedMessage).toHaveBeenCalledWith(message, 'user-1', {
      context,
      jobKey: 'notification-email-7-1',
    })
    expect(queueService.addJob).toHaveBeenCalledWith(
      { name: 'email' },
      'password_reset',
      { ...message, userId: 'user-1', messageId: MESSAGE_ID },
      { ...emailJobDefaults, jobId: 'notification-email-7-1' }
    )
    const order = [
      vi.mocked(emailMessageService.createQueuedMessage).mock.invocationCallOrder[0],
      vi.mocked(queueService.addJob).mock.invocationCallOrder[0],
    ]
    expect(order[0]).toBeLessThan(order[1] ?? 0)
  })

  it('never hands the context to BullMQ', async () => {
    await addEmailJob(message, 'user-1', { priority: 1, context: { tenantId: 'tenant-1' } })
    const options = vi.mocked(queueService.addJob).mock.calls[0]?.[3]
    expect(options).not.toHaveProperty('context')
    expect(options).toMatchObject({ priority: 1 })
  })

  it('adds no job, and rejects, when the row cannot be created', async () => {
    vi.mocked(emailMessageService.createQueuedMessage).mockRejectedValue(new Error('db down'))
    await expect(addEmailJob(message, '')).rejects.toThrow('db down')
    expect(queueService.addJob).not.toHaveBeenCalled()
  })

  it('marks the row failed at enqueue, and still rejects, when the add fails', async () => {
    vi.mocked(queueService.addJob).mockRejectedValue(new Error('redis unavailable'))
    await expect(addEmailJob(message, 'user-1')).rejects.toThrow('redis unavailable')
    expect(emailMessageService.markMessageEnqueueFailed).toHaveBeenCalledWith(MESSAGE_ID)
  })

  it('rejects with the add error, and logs, when marking the row fails too', async () => {
    vi.mocked(queueService.addJob).mockRejectedValue(new Error('redis unavailable'))
    vi.mocked(emailMessageService.markMessageEnqueueFailed).mockRejectedValue(new Error('db down'))
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {
      // Only the call is asserted.
    })
    try {
      await expect(addEmailJob(message, 'user-1')).rejects.toThrow('redis unavailable')
      expect(loggerError).toHaveBeenCalledWith(
        'Marking an unqueued email failed',
        expect.objectContaining({ messageId: MESSAGE_ID })
      )
    } finally {
      loggerError.mockRestore()
    }
  })
})
