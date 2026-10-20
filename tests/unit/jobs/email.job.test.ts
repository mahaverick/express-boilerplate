/**
 * @file addEmailJob's ordering and failure handling, with the queue and the
 * email-message service mocked: the row comes first, its id rides on the
 * job, the context never reaches BullMQ, and a failed add marks the row and
 * still rejects. The real Redis and Postgres path is
 * tests/integration/jobs/email.job.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@/database/models/email-message.model'
import {
  addEmailJob,
  AUTH_EMAIL_TEMPLATE_KEYS,
  emailJobDefaults,
  emailQueueFor,
  enqueueTrackedEmail,
} from '@/jobs/email.job'
import * as emailMessageService from '@/services/email-message.service'
import { logger } from '@/services/logger.service'
import type { MailMessage } from '@/services/mailer.service'
import * as queueService from '@/services/queue.service'
import { EMAIL_TEMPLATE_KEYS } from '@/utilities/email-template.utilities'

vi.mock('@/services/email-message.service', () => ({
  createQueuedMessage: vi.fn(),
  markMessageEnqueueFailed: vi.fn(),
}))

vi.mock('@/services/queue.service', () => ({
  addJob: vi.fn(),
  getEmailQueue: vi.fn(() => ({ name: 'email' })),
  getAuthEmailQueue: vi.fn(() => ({ name: 'auth-email' })),
}))

const MESSAGE_ID = '0190a000-0000-7000-8000-000000000002'

const message: MailMessage = {
  to: 'user@example.com',
  templateKey: 'onboarding_reminder',
  variables: {
    tenantName: 'Acme',
    appName: 'Test',
    nextStep: 'Invite a teammate',
    stepsDone: '1',
    stepsTotal: '2',
    overviewLink: 'https://example.com/tenants/acme',
  },
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

    // No executor: the row is written on the pool.
    expect(emailMessageService.createQueuedMessage).toHaveBeenCalledWith(
      message,
      'user-1',
      { context, jobKey: 'notification-email-7-1' },
      undefined
    )
    expect(queueService.addJob).toHaveBeenCalledWith(
      { name: 'email' },
      'onboarding_reminder',
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
    await expect(addEmailJob(message, '')).rejects.toThrow()
    expect(queueService.addJob).not.toHaveBeenCalled()
  })

  it('rejects without the recipient address when the insert error carries it', async () => {
    vi.mocked(emailMessageService.createQueuedMessage).mockRejectedValue(
      new Error('insert failed, params: user@example.com')
    )
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {
      // Only the call is asserted.
    })
    try {
      const rejected = expect(addEmailJob(message, 'user-1')).rejects
      await rejected.toThrow(expect.not.stringContaining('user@example.com'))
      await rejected.toThrow(/onboarding_reminder/)
    } finally {
      loggerError.mockRestore()
    }
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

describe('emailQueueFor', () => {
  it('routes sign_in_link, step_up_link, welcome, tenant_invitation and invitation_confirm to auth-email and everything else to email', () => {
    const routed = Object.fromEntries(
      EMAIL_TEMPLATE_KEYS.map((key) => [key, (emailQueueFor(key) as { name: string }).name])
    )

    expect(routed).toEqual({
      sign_in_link: 'auth-email',
      step_up_link: 'auth-email',
      welcome: 'auth-email',
      tenant_invitation: 'auth-email',
      invitation_confirm: 'auth-email',
      onboarding_reminder: 'email',
      maintenance_mode_changed: 'email',
    })
    expect(AUTH_EMAIL_TEMPLATE_KEYS).toEqual([
      'sign_in_link',
      'step_up_link',
      'welcome',
      'tenant_invitation',
      'invitation_confirm',
    ])
  })

  it('enqueues an auth template on auth-email, from addEmailJob and enqueueTrackedEmail alike', async () => {
    vi.mocked(emailMessageService.createQueuedMessage).mockResolvedValue({
      id: MESSAGE_ID,
    } as EmailMessage)
    vi.mocked(queueService.addJob)
      .mockReset()
      .mockResolvedValue({ id: 'job-1' } as never)
    const signIn: MailMessage = {
      to: 'user@example.com',
      templateKey: 'sign_in_link',
      variables: {} as never,
    }

    await addEmailJob(signIn, 'user-1')
    await enqueueTrackedEmail(signIn, 'user-1', MESSAGE_ID)

    const queues = vi.mocked(queueService.addJob).mock.calls.map((call) => call[0])
    expect(queues).toEqual([{ name: 'auth-email' }, { name: 'auth-email' }])
  })
})
