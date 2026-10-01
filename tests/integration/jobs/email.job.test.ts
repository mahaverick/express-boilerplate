/**
 * @file addEmailJob against the real Redis and per-worker Postgres: the
 * `email_messages` row it creates, job-key idempotency, and what a failed
 * add leaves behind. No Worker runs here, so jobs stay on the queue;
 * `afterAll` obliterates it.
 */
import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { addEmailJob } from '@/jobs/email.job'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { sql } from '@/services/database.service'
import type { MailMessage } from '@/services/mailer.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { withMutatedMethod } from '../../helpers/mutate'

const messages = new EmailMessageRepository()
const recipients: string[] = []

afterEach(async () => {
  if (recipients.length > 0)
    await sql`delete from email_messages where recipient = any(${recipients})`
  recipients.length = 0
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A disposable recipient, tracked for cleanup.
 * @returns A unique address.
 */
function uniqueRecipient(): string {
  const address = `email-job-${randomUUID()}@example.test`
  recipients.push(address)
  return address
}

/**
 * A real invitation message: the template with the most variables, one of
 * which (`inviterName`) must never be stored.
 * @param to - The recipient.
 * @param token - The token in its accept link.
 * @returns The message.
 */
function invitationMessage(to: string, token: string): MailMessage {
  return {
    to,
    templateKey: 'tenant_invitation',
    variables: {
      tenantName: 'Acme Inc',
      inviterName: 'Grace Hopper',
      role: 'editor',
      acceptUrl: `https://web.example.test/invitations/accept?token=${token}`,
      expiresInDays: '7',
      appName: 'Test App',
    },
  }
}

/**
 * A stand-in for a queue add or an insert that fails.
 * @returns A rejection.
 */
function failingCall(): Promise<never> {
  return Promise.reject(new Error('unavailable'))
}

/**
 * The job's message row, read back.
 * @param messageId - The job's `messageId`.
 * @returns The row.
 */
async function rowFor(messageId: string | undefined): Promise<Record<string, unknown>> {
  const [row] = await sql`select * from email_messages where id = ${messageId ?? ''}`
  if (!row) throw new Error('no email_messages row for the job')
  return row
}

describe('addEmailJob', () => {
  it('stores a queued row with the context, the sender, and only the preview variables', async () => {
    const to = uniqueRecipient()
    const token = randomUUID()
    const tenantId = randomUUID()
    const invitationId = randomUUID()

    const job = await addEmailJob(invitationMessage(to, token), '', {
      context: { tenantId, invitationId, linkApp: 'web' },
    })

    const row = await rowFor(job.data.messageId)
    expect(row).toMatchObject({
      recipient: to,
      template_key: 'tenant_invitation',
      tenant_id: tenantId,
      invitation_id: invitationId,
      link_app: 'web',
      sender_class: 'transactional',
      status: 'queued',
      message_id_header: `<${String(row.id)}@mail.example.test>`,
      variables: {
        tenantName: 'Acme Inc',
        role: 'editor',
        expiresInDays: '7',
        appName: 'Test App',
      },
    })
    expect(row.user_id).toBeNull()
    expect(JSON.stringify(row)).not.toContain(token)
    expect(JSON.stringify(row)).not.toContain('Grace Hopper')
  })

  it("builds a token-free template's Message-ID on the general sender's domain", async () => {
    const to = uniqueRecipient()
    const job = await addEmailJob(
      { to, templateKey: 'password_changed', variables: { firstName: 'Ada', appName: 'Test' } },
      'user-1'
    )
    const row = await rowFor(job.data.messageId)
    expect(row).toMatchObject({
      sender_class: 'general',
      user_id: 'user-1',
      message_id_header: `<${String(row.id)}@example.com>`,
    })
  })

  it('records the message a resend was made from', async () => {
    const first = await addEmailJob(invitationMessage(uniqueRecipient(), randomUUID()), '')
    const resent = await addEmailJob(invitationMessage(uniqueRecipient(), randomUUID()), '', {
      context: { resentFromId: first.data.messageId ?? '' },
    })
    const row = await rowFor(resent.data.messageId)
    expect(row.resent_from_id).toBe(first.data.messageId)
  })

  it('with a fixed jobId, a retried add reuses the row and the job: no orphan', async () => {
    const to = uniqueRecipient()
    const jobId = `notification-email-${randomUUID()}-1`

    const first = await addEmailJob(invitationMessage(to, randomUUID()), '', { jobId })
    const retry = await addEmailJob(invitationMessage(to, randomUUID()), '', { jobId })

    expect(retry.id).toBe(first.id)
    expect(retry.data.messageId).toBe(first.data.messageId)
    const rows = await sql`select id, job_key from email_messages where recipient = ${to}`
    expect(rows).toEqual([{ id: first.data.messageId, job_key: jobId }])
  })

  it('marks the row failed at enqueue when the add fails, and a retry puts it back to queued', async () => {
    const to = uniqueRecipient()
    const jobId = `notification-email-${randomUUID()}-1`
    const message = invitationMessage(to, randomUUID())
    const addUnavailable = failingCall as Queue['add']

    await withMutatedMethod(Queue.prototype, 'add', addUnavailable, async () => {
      await expect(addEmailJob(message, '', { jobId })).rejects.toThrow('unavailable')
    })
    const [failed] = await sql`
      select id, status, failure_origin from email_messages where recipient = ${to}
    `
    expect(failed).toMatchObject({ status: 'failed', failure_origin: 'enqueue' })

    const retry = await addEmailJob(message, '', { jobId })

    expect(retry.data.messageId).toBe(failed?.id)
    const found = await messages.findById(String(failed?.id))
    expect(found?.status).toBe('queued')
    expect(found?.failureOrigin).toBeNull()
  })

  it('adds no job when the row cannot be written', async () => {
    const to = uniqueRecipient()
    const message = invitationMessage(to, randomUUID())

    await withMutatedMethod(
      EmailMessageRepository.prototype,
      'createQueued',
      failingCall,
      async () => {
        await expect(addEmailJob(message, '')).rejects.toThrow('unavailable')
      }
    )

    const jobs = await getEmailQueue().getJobs(['waiting', 'prioritized', 'delayed'])
    expect(jobs.some((job) => (job.data as { to?: string }).to === to)).toBe(false)
  })
})
