/**
 * @file Email message rows and signed fake webhook bodies for the tracking
 * tests. Messages are inserted with raw SQL, so a fixture never depends on
 * enqueue; every recipient starts with the caller's prefix, which
 * `deleteTrackingRows` cleans up by (events cascade with their message).
 */
import { randomUUID } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import type { EmailMessageStatus, SenderClass } from '@/constants/email.constants'
import { sql } from '@/services/database.service'
import {
  FAKE_SIGNATURE_HEADER,
  fakeEmailWebhookSignature,
} from '@/services/email-webhook-fake.service'

// postgres-js binds SQL NULL only from null; an undefined parameter throws.
// eslint-disable-next-line unicorn/no-null -- see above
const SQL_NULL = null

/**
 * A message row a test inserted.
 */
export interface TestMessage {
  id: string
  recipient: string
  header: string
}

/**
 * How `insertTestMessage` builds its row. Defaults: a random recipient
 * under the prefix, `email_verification`, transactional, `sent`, now.
 */
export interface TestMessageOptions {
  recipient?: string
  templateKey?: string
  senderClass?: SenderClass
  status?: EmailMessageStatus
  userId?: string | null
  tenantId?: string | null
  createdAt?: string
}

/**
 * Insert one `email_messages` row.
 * @param prefix - The recipient prefix the file cleans up by.
 * @param options - How to build the row.
 * @returns Its id, recipient and Message-ID header.
 */
export async function insertTestMessage(
  prefix: string,
  options: TestMessageOptions = {}
): Promise<TestMessage> {
  const [row] = await sql<{ id: string }[]>`select uuidv7()::text as id`
  if (!row) throw new Error('uuidv7() returned no row')
  const recipient = options.recipient ?? `${prefix}${randomUUID()}@example.test`
  const header = `<${row.id}@mail.example.test>`
  const createdAt = options.createdAt ?? new Date().toISOString()
  await sql`
    insert into email_messages
      (id, recipient, template_key, user_id, tenant_id, sender_class, message_id_header, status, status_updated_at, created_at)
    values
      (${row.id}, ${recipient}, ${options.templateKey ?? 'email_verification'}, ${options.userId ?? SQL_NULL},
       ${options.tenantId ?? SQL_NULL}, ${options.senderClass ?? 'transactional'}, ${header},
       ${options.status ?? 'sent'}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)`
  return { id: row.id, recipient, header }
}

/**
 * Delete every message, event and suppression under a recipient prefix.
 * @param prefix - The prefix the file's recipients start with.
 * @returns Resolves once the rows are gone.
 */
export async function deleteTrackingRows(prefix: string): Promise<void> {
  const like = `${prefix}%`
  await sql`delete from email_suppressions where address like ${like.toLowerCase()}`
  await sql`delete from email_messages where recipient like ${like}`
}

/**
 * One fake webhook event body.
 */
export interface FakeEvent {
  id?: string
  type: string
  messageId: string
  bounceKind?: 'hard' | 'soft'
  occurredAt?: string
}

/**
 * A fake webhook body and the headers that sign it with the test
 * environment's `FAKE_EMAIL_WEBHOOK_SECRET`.
 * @param events - One event, or several for one request.
 * @returns The exact body bytes and the headers to send with them.
 */
export function signedFakeBody(events: FakeEvent | FakeEvent[]): {
  body: Buffer
  headers: Record<string, string>
} {
  const withIds = (Array.isArray(events) ? events : [events]).map((event) => ({
    id: `evt-${randomUUID()}`,
    ...event,
  }))
  const body = Buffer.from(JSON.stringify(Array.isArray(events) ? withIds : withIds[0]))
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [FAKE_SIGNATURE_HEADER]: fakeEmailWebhookSignature(body, getEnv().FAKE_EMAIL_WEBHOOK_SECRET),
    },
  }
}
