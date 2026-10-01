/**
 * @file The `email_messages` row that tracks one logical email: created at
 * enqueue (or by the worker, for a job queued before tracking existed) and
 * moved forward by the email worker. Stored variables are only the
 * template's `previewVariables`, so no link or token reaches the row.
 */
import { getEnv } from '@/configs/env.config'
import type { EmailMessage } from '@/database/models/email-message.model'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import type { MailMessage } from '@/services/mailer.service'
import { EMAIL_TEMPLATE_META } from '@/templates/email/email-template-meta.template'
import type { EmailContext } from '@/types/email-context'
import { senderDomain, senderFor } from '@/utilities/email-sender.utilities'

const messageRepository = new EmailMessageRepository()
const suppressionRepository = new EmailSuppressionRepository()

/**
 * Where a new message came from, beyond its template and recipient.
 */
export interface NewMessageOrigin {
  /**
   * The caller's facts about the mail.
   */
  context?: EmailContext | undefined
  /**
   * The fixed BullMQ job id, when the caller gave one.
   */
  jobKey?: string | undefined
}

/**
 * The template's `previewVariables`, read from the message's variables:
 * every other variable, a token link included, is left behind.
 * @param message - The email being enqueued.
 * @returns The variables to store, only those that are strings.
 */
function storedVariables(message: MailMessage): Record<string, string> {
  const names = EMAIL_TEMPLATE_META[message.templateKey].previewVariables
  const source: Readonly<Record<string, unknown>> = { ...message.variables }
  const stored: Record<string, string> = {}
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string') stored[name] = value
  }
  return stored
}

/**
 * Create the `queued` message row for one email, with its Message-ID
 * header built from a fresh id and the template's sender. A `jobKey`
 * another row holds returns that row instead (`createQueued`).
 * @param message - The email.
 * @param userId - The account it is for; `''` when there is none, stored as NULL.
 * @param origin - The caller's context and fixed job id, if any.
 * @returns The message row.
 * @throws {Error} Whatever the id read or the insert throws.
 */
export async function createQueuedMessage(
  message: MailMessage,
  userId: string,
  origin: NewMessageOrigin = {}
): Promise<EmailMessage> {
  const { context = {}, jobKey } = origin
  const { senderClass } = EMAIL_TEMPLATE_META[message.templateKey]
  const domain = senderDomain(senderFor(senderClass, getEnv()))
  const id = await messageRepository.nextId()
  return messageRepository.createQueued({
    id,
    recipient: message.to,
    templateKey: message.templateKey,
    userId: userId === '' ? undefined : userId,
    tenantId: context.tenantId,
    invitationId: context.invitationId,
    linkApp: context.linkApp,
    senderClass,
    messageIdHeader: `<${id}@${domain}>`,
    jobKey,
    variables: storedVariables(message),
    resentFromId: context.resentFromId,
  })
}

/**
 * One message by id.
 * @param id - The message.
 * @returns The row, or undefined when it is gone (purged).
 */
export async function findMessage(id: string): Promise<EmailMessage | undefined> {
  return messageRepository.findById(id)
}

/**
 * Whether an address is actively suppressed, so nothing may be sent to it.
 * @param address - The recipient, in any case.
 * @returns True when an active suppression exists.
 */
export async function isRecipientSuppressed(address: string): Promise<boolean> {
  return (await suppressionRepository.findActive(address)) !== undefined
}

/**
 * Mark a message that was never sent because its recipient is suppressed.
 * Only a `queued` message changes.
 * @param id - The message.
 * @returns Resolves once the row is written.
 */
export async function markMessageSuppressed(id: string): Promise<void> {
  await messageRepository.markSuppressed(id)
}

/**
 * Record that a message left this server. A `delivered` (or later) status
 * from a faster webhook is kept.
 * @param id - The message.
 * @returns Resolves once the row is written.
 */
export async function markMessageSent(id: string): Promise<void> {
  await messageRepository.advanceStatus(id, 'sent')
}

/**
 * Record that every send attempt for a message failed.
 * @param id - The message.
 * @returns Resolves once the row is written.
 */
export async function markMessageSendFailed(id: string): Promise<void> {
  await messageRepository.advanceStatus(id, 'failed', { failureOrigin: 'send' })
}

/**
 * Record that a message's job never reached the queue.
 * @param id - The message.
 * @returns Resolves once the row is written.
 */
export async function markMessageEnqueueFailed(id: string): Promise<void> {
  await messageRepository.advanceStatus(id, 'failed', { failureOrigin: 'enqueue' })
}
