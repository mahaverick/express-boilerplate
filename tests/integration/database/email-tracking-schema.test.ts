/**
 * @file What migration 0020 built, asserted against the live per-worker
 * database with raw SQL, so no application check stands in for the
 * database's: the CHECKs on email_messages, email_events and
 * email_suppressions, their unique keys, and the foreign keys' delete rules.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'

const createdMessageIds: string[] = []
const createdSuppressionAddresses: string[] = []

afterEach(async () => {
  if (createdSuppressionAddresses.length > 0)
    await sql`delete from email_suppressions where address = any(${createdSuppressionAddresses})`
  createdSuppressionAddresses.length = 0
  if (createdMessageIds.length > 0)
    await sql`delete from email_messages where id = any(${createdMessageIds})`
  createdMessageIds.length = 0
})

/**
 * Insert one valid queued message, tracked for cleanup.
 * @param overrides - Columns to set instead of the defaults, as raw values.
 * @param overrides.resentFromId - The message it was resent from.
 * @returns The message's id.
 */
async function insertMessage(overrides: { resentFromId?: string } = {}): Promise<string> {
  const id = randomUUID()
  // eslint-disable-next-line unicorn/no-null -- a SQL NULL: postgres.js refuses undefined parameters
  const resentFromId = overrides.resentFromId ?? null
  await sql`
    insert into email_messages (id, recipient, template_key, sender_class, message_id_header, status, resent_from_id)
    values (${id}, ${`schema-${id}@example.test`}, 'password_reset', 'transactional', ${`<${id}@example.test>`}, 'queued', ${resentFromId})
  `
  createdMessageIds.push(id)
  return id
}

/**
 * Insert one valid delivered event for a message.
 * @param messageId - The message.
 * @returns The event's id.
 */
async function insertEvent(messageId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
    values (${messageId}, 'fake', ${randomUUID()}, 'delivered', now())
    returning id
  `
  if (!row) throw new Error('event insert returned no row')
  return row.id
}

describe('email_messages CHECKs', () => {
  it.each([
    ['an unknown status', 'email_messages_status_check', { status: 'bogus' }],
    ['an unknown sender class', 'email_messages_sender_class_check', { sender_class: 'bulk' }],
    ['an unknown link app', 'email_messages_link_app_check', { link_app: 'admin' }],
    ['an unknown failure origin', 'email_messages_failure_origin_check', { failure_origin: 'x' }],
  ])('refuses %s (%s)', async (_label, constraint, bad) => {
    const id = randomUUID()
    const row = {
      id,
      recipient: `check-${id}@example.test`,
      template_key: 'password_reset',
      sender_class: 'transactional',
      message_id_header: `<${id}@example.test>`,
      status: 'queued',
      ...bad,
    }
    await expect(sql`insert into email_messages ${sql(row)}`).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraint,
    })
  })

  it('refuses a second message with the same Message-ID header', async () => {
    const id = await insertMessage()
    const other = randomUUID()
    await expect(sql`
      insert into email_messages (id, recipient, template_key, sender_class, message_id_header, status)
      values (${other}, 'dup@example.test', 'password_reset', 'transactional', ${`<${id}@example.test>`}, 'queued')
    `).rejects.toMatchObject({ code: '23505' })
  })

  it('clears resent_from_id when the original message is deleted', async () => {
    const original = await insertMessage()
    const resent = await insertMessage({ resentFromId: original })
    await sql`delete from email_messages where id = ${original}`
    const [row] = await sql`select resent_from_id from email_messages where id = ${resent}`
    expect(row?.resent_from_id).toBeNull()
  })
})

describe('email_events CHECKs', () => {
  it('refuses a token-shaped detail', async () => {
    const messageId = await insertMessage()
    const token = randomBytes(16).toString('hex')
    await expect(sql`
      insert into email_events (message_id, provider, provider_event_id, type, detail, occurred_at)
      values (${messageId}, 'fake', ${randomUUID()}, 'failed', ${token}, now())
    `).rejects.toMatchObject({ code: '23514', constraint_name: 'email_events_detail_check' })
  })

  it.each([
    // eslint-disable-next-line unicorn/no-null -- a SQL NULL bounce_kind
    ['a bounce with no kind', 'bounced', null],
    ['a kind on a non-bounce', 'delivered', 'hard'],
  ])('refuses %s', async (_label, type, bounceKind) => {
    const messageId = await insertMessage()
    await expect(sql`
      insert into email_events (message_id, provider, provider_event_id, type, bounce_kind, occurred_at)
      values (${messageId}, 'fake', ${randomUUID()}, ${type}, ${bounceKind}, now())
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_events_bounce_kind_presence_check',
    })
  })

  it('refuses an unknown event type', async () => {
    const messageId = await insertMessage()
    await expect(sql`
      insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
      values (${messageId}, 'fake', ${randomUUID()}, 'sent', now())
    `).rejects.toMatchObject({ code: '23514', constraint_name: 'email_events_type_check' })
  })

  it('refuses the same provider event twice', async () => {
    const messageId = await insertMessage()
    const eventId = randomUUID()
    await sql`
      insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
      values (${messageId}, 'fake', ${eventId}, 'delivered', now())
    `
    await expect(sql`
      insert into email_events (message_id, provider, provider_event_id, type, occurred_at)
      values (${messageId}, 'fake', ${eventId}, 'delivered', now())
    `).rejects.toMatchObject({ code: '23505' })
  })

  it("goes with its message, and with it the message's attempts", async () => {
    const messageId = await insertMessage()
    const eventId = await insertEvent(messageId)
    const [log] = await sql<{ id: string }[]>`
      insert into email_logs (recipient, template_key, status, message_id)
      values ('cascade@example.test', 'password_reset', 'sent', ${messageId})
      returning id
    `
    await sql`delete from email_messages where id = ${messageId}`
    expect(await sql`select 1 from email_events where id = ${eventId}`).toHaveLength(0)
    expect(await sql`select 1 from email_logs where id = ${log?.id ?? ''}`).toHaveLength(0)
  })
})

describe('email_suppressions', () => {
  it('refuses an address that is not lowercased', async () => {
    await expect(sql`
      insert into email_suppressions (address, reason) values ('Mixed@Example.test', 'hard_bounce')
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'email_suppressions_address_lower_check',
    })
  })

  it('refuses an unknown reason', async () => {
    await expect(sql`
      insert into email_suppressions (address, reason) values ('reason@example.test', 'spam')
    `).rejects.toMatchObject({ code: '23514', constraint_name: 'email_suppressions_reason_check' })
  })

  it('holds one active suppression per address, and any number of lifted ones', async () => {
    const address = `suppressed-${randomUUID()}@example.test`
    createdSuppressionAddresses.push(address)
    await sql`insert into email_suppressions (address, reason, lifted_at) values (${address}, 'complaint', now())`
    await sql`insert into email_suppressions (address, reason) values (${address}, 'hard_bounce')`
    await expect(
      sql`insert into email_suppressions (address, reason) values (${address}, 'complaint')`
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('keeps a suppression when its source event is deleted', async () => {
    const messageId = await insertMessage()
    const eventId = await insertEvent(messageId)
    const address = `source-${randomUUID()}@example.test`
    createdSuppressionAddresses.push(address)
    await sql`insert into email_suppressions (address, reason, source_event_id) values (${address}, 'hard_bounce', ${eventId})`
    await sql`delete from email_messages where id = ${messageId}`
    const [row] =
      await sql`select source_event_id from email_suppressions where address = ${address}`
    expect(row).toBeDefined()
    expect(row?.source_event_id).toBeNull()
  })
})
