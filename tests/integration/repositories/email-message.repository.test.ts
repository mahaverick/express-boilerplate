/**
 * @file EmailMessageRepository against the real per-worker Postgres: id
 * allocation, job-key idempotency, the secret-variable guard, and the
 * rank-only-forward status writes. Every row this file creates is deleted
 * in `afterEach`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EmailMessageRepository,
  type NewQueuedEmailMessage,
} from '@/repositories/email-message.repository'
import { sql } from '@/services/database.service'

const repository = new EmailMessageRepository()
const createdIds: string[] = []

afterEach(async () => {
  if (createdIds.length === 0) return
  await sql`delete from email_messages where id = any(${createdIds})`
  createdIds.length = 0
})

/**
 * A queued message with a fresh id, header and recipient.
 * @param overrides - Fields to change.
 * @returns The row to pass to `createQueued`.
 */
async function queuedRow(
  overrides: Partial<NewQueuedEmailMessage> = {}
): Promise<NewQueuedEmailMessage> {
  const id = await repository.nextId()
  createdIds.push(id)
  return {
    id,
    recipient: `message-repo-${id}@example.test`,
    templateKey: 'password_reset',
    senderClass: 'transactional',
    messageIdHeader: `<${id}@example.test>`,
    variables: { firstName: 'Ada', appName: 'Test App' },
    ...overrides,
  }
}

describe('EmailMessageRepository.nextId', () => {
  it('returns a uuidv7 from Postgres', async () => {
    const id = await repository.nextId()
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  })
})

describe('EmailMessageRepository.createQueued', () => {
  it('inserts a queued message with exactly the given columns', async () => {
    const row = await queuedRow({ userId: 'user-1', linkApp: 'apex' })
    const created = await repository.createQueued(row)
    expect(created).toMatchObject({
      id: row.id,
      recipient: row.recipient,
      templateKey: 'password_reset',
      userId: 'user-1',
      linkApp: 'apex',
      senderClass: 'transactional',
      messageIdHeader: row.messageIdHeader,
      variables: { firstName: 'Ada', appName: 'Test App' },
      status: 'queued',
    })
    for (const column of [
      'tenantId',
      'invitationId',
      'jobKey',
      'failureOrigin',
      'resentFromId',
    ] as const) {
      expect(created[column]).toBeNull()
    }
  })

  it('returns the existing row for a job key it already holds, and inserts nothing', async () => {
    const jobKey = `notification-email-${randomUUID()}`
    const first = await repository.createQueued(await queuedRow({ jobKey }))
    const retry = await repository.createQueued(await queuedRow({ jobKey }))
    expect(retry.id).toBe(first.id)
    expect(retry.messageIdHeader).toBe(first.messageIdHeader)
    const rows = await sql`select id from email_messages where job_key = ${jobKey}`
    expect(rows).toHaveLength(1)
  })

  it('puts a message that failed at enqueue back to queued when the enqueue is retried', async () => {
    const jobKey = `notification-email-${randomUUID()}`
    const first = await repository.createQueued(await queuedRow({ jobKey }))
    await repository.advanceStatus(first.id, 'failed', { failureOrigin: 'enqueue' })

    const retry = await repository.createQueued(await queuedRow({ jobKey }))

    expect(retry).toMatchObject({ id: first.id, status: 'queued' })
    expect(retry.failureOrigin).toBeNull()
  })

  it('leaves a message that already went out alone when its job key comes back', async () => {
    const jobKey = `notification-email-${randomUUID()}`
    const first = await repository.createQueued(await queuedRow({ jobKey }))
    await repository.advanceStatus(first.id, 'sent')

    const retry = await repository.createQueued(await queuedRow({ jobKey }))

    expect(retry).toMatchObject({ id: first.id, status: 'sent' })
  })

  it.each(['resetUrl', 'acceptUrl', 'refreshToken'])(
    'refuses to store a variable named %s, and writes nothing',
    async (key) => {
      const row = await queuedRow({ variables: { firstName: 'Ada', [key]: 'x' } })
      await expect(repository.createQueued(row)).rejects.toThrow(key)
      expect(await sql`select 1 from email_messages where id = ${row.id}`).toHaveLength(0)
    }
  )
})

describe('EmailMessageRepository.advanceStatus', () => {
  it('moves a queued message to sent', async () => {
    const created = await repository.createQueued(await queuedRow())
    await expect(repository.advanceStatus(created.id, 'sent')).resolves.toBe(true)
    const found = await repository.findById(created.id)
    expect(found?.status).toBe('sent')
  })

  it('never lets sent overwrite delivered', async () => {
    const created = await repository.createQueued(await queuedRow())
    await repository.advanceStatus(created.id, 'delivered')

    await expect(repository.advanceStatus(created.id, 'sent')).resolves.toBe(false)

    const found = await repository.findById(created.id)
    expect(found?.status).toBe('delivered')
  })

  it('refuses a move to the same rank (failed after bounced)', async () => {
    const created = await repository.createQueued(await queuedRow())
    await repository.advanceStatus(created.id, 'bounced')
    await expect(
      repository.advanceStatus(created.id, 'failed', { failureOrigin: 'provider' })
    ).resolves.toBe(false)
    const found = await repository.findById(created.id)
    expect(found?.status).toBe('bounced')
    expect(found?.failureOrigin).toBeNull()
  })

  it('records who set failed', async () => {
    const created = await repository.createQueued(await queuedRow())
    await repository.advanceStatus(created.id, 'failed', { failureOrigin: 'send' })
    expect(await repository.findById(created.id)).toMatchObject({
      status: 'failed',
      failureOrigin: 'send',
    })
  })

  it('moves status_updated_at with the status', async () => {
    const created = await repository.createQueued(await queuedRow())
    await sql`update email_messages set status_updated_at = '2001-01-01T00:00:00Z' where id = ${created.id}`
    await repository.advanceStatus(created.id, 'sent')
    const found = await repository.findById(created.id)
    expect(found?.statusUpdatedAt.getTime()).toBeGreaterThan(Date.parse('2001-01-02T00:00:00Z'))
  })

  it('never advances a suppressed message', async () => {
    const created = await repository.createQueued(await queuedRow())
    await repository.markSuppressed(created.id)
    await expect(repository.advanceStatus(created.id, 'sent')).resolves.toBe(false)
    const found = await repository.findById(created.id)
    expect(found?.status).toBe('suppressed')
  })
})

describe('EmailMessageRepository.markSuppressed', () => {
  it('suppresses a queued message', async () => {
    const created = await repository.createQueued(await queuedRow())
    await expect(repository.markSuppressed(created.id)).resolves.toBe(true)
    const found = await repository.findById(created.id)
    expect(found?.status).toBe('suppressed')
  })

  it('leaves a message that already went out alone', async () => {
    const created = await repository.createQueued(await queuedRow())
    await repository.advanceStatus(created.id, 'sent')
    await expect(repository.markSuppressed(created.id)).resolves.toBe(false)
    const found = await repository.findById(created.id)
    expect(found?.status).toBe('sent')
  })
})

describe('EmailMessageRepository lookups', () => {
  it('finds a message by its Message-ID header', async () => {
    const created = await repository.createQueued(await queuedRow())
    await expect(repository.findByMessageIdHeader(created.messageIdHeader)).resolves.toMatchObject({
      id: created.id,
    })
    await expect(repository.findByMessageIdHeader('<nobody@example.test>')).resolves.toBeUndefined()
  })
})
