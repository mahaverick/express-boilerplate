/**
 * @file EmailEventRepository against the real per-worker Postgres:
 * deduplication by provider event id, and a malformed detail dropped
 * rather than failing the insert.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { EmailEventRepository } from '@/repositories/email-event.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { sql } from '@/services/database.service'

const events = new EmailEventRepository()
const messages = new EmailMessageRepository()
const createdMessageIds: string[] = []

afterEach(async () => {
  if (createdMessageIds.length === 0) return
  await sql`delete from email_messages where id = any(${createdMessageIds})`
  createdMessageIds.length = 0
})

/**
 * One queued message to hang events on, tracked for cleanup.
 * @returns Its id.
 */
async function messageId(): Promise<string> {
  const id = await messages.nextId()
  createdMessageIds.push(id)
  await messages.createQueued({
    id,
    recipient: `event-repo-${id}@example.test`,
    templateKey: 'password_changed',
    senderClass: 'general',
    messageIdHeader: `<${id}@example.test>`,
  })
  return id
}

describe('EmailEventRepository.insertIfNew', () => {
  it('records an event, and returns undefined for the same provider event again', async () => {
    const id = await messageId()
    const row = {
      messageId: id,
      provider: 'fake',
      providerEventId: randomUUID(),
      type: 'delivered' as const,
      occurredAt: new Date(),
    }
    const inserted = await events.insertIfNew(row)
    expect(inserted).toMatchObject({ messageId: id, provider: 'fake', type: 'delivered' })
    await expect(events.insertIfNew(row)).resolves.toBeUndefined()
    const rows = await sql`select 1 from email_events where message_id = ${id}`
    expect(rows).toHaveLength(1)
  })

  it('keeps the same provider event id from two providers apart', async () => {
    const id = await messageId()
    const providerEventId = randomUUID()
    const base = { messageId: id, providerEventId, type: 'opened' as const, occurredAt: new Date() }
    await expect(events.insertIfNew({ ...base, provider: 'fake' })).resolves.toBeDefined()
    await expect(events.insertIfNew({ ...base, provider: 'resend' })).resolves.toBeDefined()
  })

  it('stores a valid detail as given', async () => {
    const id = await messageId()
    const inserted = await events.insertIfNew({
      messageId: id,
      provider: 'fake',
      providerEventId: randomUUID(),
      type: 'bounced',
      bounceKind: 'hard',
      detail: 'MESSAGE_REJECTED',
      occurredAt: new Date(),
    })
    expect(inserted?.detail).toBe('MESSAGE_REJECTED')
  })

  it.each([
    ['token-shaped', randomBytes(16).toString('hex')],
    ['over-long', 'A'.repeat(33)],
  ])('drops a %s detail instead of failing the insert', async (_label, detail) => {
    const id = await messageId()
    const inserted = await events.insertIfNew({
      messageId: id,
      provider: 'fake',
      providerEventId: randomUUID(),
      type: 'failed',
      detail,
      occurredAt: new Date(),
    })
    expect(inserted).toBeDefined()
    expect(inserted?.detail).toBeNull()
  })
})
