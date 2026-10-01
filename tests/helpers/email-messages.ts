/**
 * @file Email tracking rows for the staff email tests, inserted directly.
 * Every message and suppression made here is tracked; call
 * `deleteTrackedEmailRows` in an afterEach. Deleting a message cascades to
 * its attempts and events, and also removes the messages resent from it.
 */
import { randomUUID } from 'node:crypto'
import type { BounceKind, EmailEventType, SuppressionReason } from '@/constants/email.constants'
import { emailEventModel, type EmailEvent } from '@/database/models/email-event.model'
import { emailLogModel, type EmailLogStatus } from '@/database/models/email-log.model'
import {
  emailMessageModel,
  type EmailMessage,
  type NewEmailMessage,
} from '@/database/models/email-message.model'
import {
  emailSuppressionModel,
  type EmailSuppression,
} from '@/database/models/email-suppression.model'
import { db, sql } from '@/services/database.service'

const trackedMessageIds: string[] = []
const trackedSuppressionIds: string[] = []

/**
 * Insert one message and track it. Defaults: a random `@example.test`
 * recipient, an `account_setup` mail with no user, status `sent`, stored
 * variables `{ firstName: 'Ada', appName: 'Acme' }`, linked to the web app.
 * @param overrides - Columns to set instead.
 * @returns The inserted row.
 */
export async function createTrackedMessage(
  overrides: Partial<NewEmailMessage> = {}
): Promise<EmailMessage> {
  const id = overrides.id ?? randomUUID()
  const [row] = await db
    .insert(emailMessageModel)
    .values({
      id,
      recipient: `em-${randomUUID()}@example.test`,
      templateKey: 'account_setup',
      senderClass: 'transactional',
      messageIdHeader: `<${id}@example.test>`,
      status: 'sent',
      variables: { firstName: 'Ada', appName: 'Acme' },
      linkApp: 'web',
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('createTrackedMessage: insert returned no row')
  trackedMessageIds.push(row.id)
  return row
}

/**
 * Append one provider event to a message.
 * @param messageId - The message.
 * @param type - The event type.
 * @param options - Bounce kind, detail, and the two timestamps (default now).
 * @param options.bounceKind - Required for `bounced`.
 * @param options.detail - An UPPER_SNAKE detail.
 * @param options.occurredAt - The provider's timestamp.
 * @param options.receivedAt - When it arrived.
 * @returns The inserted event.
 */
export async function addEvent(
  messageId: string,
  type: EmailEventType,
  options: { bounceKind?: BounceKind; detail?: string; occurredAt?: Date; receivedAt?: Date } = {}
): Promise<EmailEvent> {
  const [row] = await db
    .insert(emailEventModel)
    .values({
      messageId,
      provider: 'fake',
      providerEventId: randomUUID(),
      type,
      bounceKind: options.bounceKind,
      detail: options.detail,
      occurredAt: options.occurredAt ?? new Date(),
      ...(options.receivedAt && { receivedAt: options.receivedAt }),
    })
    .returning()
  if (!row) throw new Error('addEvent: insert returned no row')
  return row
}

/**
 * Append one send attempt to a message.
 * @param message - The message.
 * @param status - The attempt's outcome.
 * @param errorCode - The nodemailer code of a failed attempt.
 * @returns The attempt's id.
 */
export async function addAttempt(
  message: EmailMessage,
  status: EmailLogStatus,
  errorCode?: string
): Promise<string> {
  const [row] = await db
    .insert(emailLogModel)
    .values({
      messageId: message.id,
      recipient: message.recipient,
      templateKey: message.templateKey,
      status,
      errorCode,
    })
    .returning({ id: emailLogModel.id })
  if (!row) throw new Error('addAttempt: insert returned no row')
  return row.id
}

/**
 * Insert one suppression and track it.
 * @param address - The address, stored lowercased.
 * @param options - Reason (default `hard_bounce`), the source event, and whether it is lifted already.
 * @param options.reason - Why the address is suppressed.
 * @param options.sourceEventId - The event that caused it.
 * @param options.isLifted - Insert it lifted, by nobody, with a reason.
 * @param options.createdAt - When it was created.
 * @returns The inserted row.
 */
export async function createTrackedSuppression(
  address: string,
  options: {
    reason?: SuppressionReason
    sourceEventId?: string
    isLifted?: boolean
    createdAt?: Date
  } = {}
): Promise<EmailSuppression> {
  const [row] = await db
    .insert(emailSuppressionModel)
    .values({
      address: address.toLowerCase(),
      reason: options.reason ?? 'hard_bounce',
      sourceEventId: options.sourceEventId,
      ...(options.isLifted === true && { liftedAt: new Date(), liftReason: 'Test lift' }),
      ...(options.createdAt && { createdAt: options.createdAt }),
    })
    .returning()
  if (!row) throw new Error('createTrackedSuppression: insert returned no row')
  trackedSuppressionIds.push(row.id)
  return row
}

/**
 * Delete every tracked suppression and message, and the messages resent
 * from a tracked one (the delegated actions insert those).
 * @returns Resolves once the rows are gone.
 */
export async function deleteTrackedEmailRows(): Promise<void> {
  if (trackedSuppressionIds.length > 0) {
    await sql`delete from email_suppressions where id = any(${trackedSuppressionIds})`
    trackedSuppressionIds.length = 0
  }
  if (trackedMessageIds.length === 0) return
  await sql`delete from email_messages where resent_from_id = any(${trackedMessageIds})`
  await sql`delete from email_messages where id = any(${trackedMessageIds})`
  trackedMessageIds.length = 0
}
