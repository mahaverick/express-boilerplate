/**
 * @file Resend events applied end to end through `processEmailWebhook` and
 * the real database, with a Resend adapter built on a secret generated per
 * run (the suite sets no RESEND_WEBHOOK_SECRET, so the route itself answers
 * 404; tests/integration/api/email-webhook.test.ts covers that).
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from '@/services/database.service'
import { createResendEmailWebhookAdapter } from '@/services/email-webhook-resend.service'
import { processEmailWebhook } from '@/services/email-webhook.service'
import { deleteTrackingRows, insertTestMessage } from '../../helpers/email-tracking'

const PREFIX = `resend-${randomUUID()}-`
const key = randomBytes(24)
const adapter = createResendEmailWebhookAdapter({ secret: `whsec_${key.toString('base64')}` })

afterEach(async () => {
  await deleteTrackingRows(PREFIX)
})

/**
 * A Resend event body and its Svix headers, signed now.
 * @param type - The Resend event type.
 * @param messageId - `data.message_id`.
 * @param data - Extra `data` fields.
 * @param svixId - The event id; a fresh one by default.
 * @returns The body and headers.
 */
function resendRequest(
  type: string,
  messageId: string,
  data: Record<string, unknown> = {},
  svixId = `msg_${randomBytes(10).toString('hex')}`
): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(
    JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data: { email_id: randomUUID(), message_id: messageId, to: ['x@example.test'], ...data },
    })
  )
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${svixId}.${timestamp}.`), body]))
    .digest('base64')
  return {
    body,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  }
}

/**
 * Apply one Resend request.
 * @param request - The body and headers.
 * @param request.body - The exact body bytes.
 * @param request.headers - The Svix headers.
 * @returns The processing result.
 */
function apply(request: { body: Buffer; headers: Record<string, string> }) {
  return processEmailWebhook(adapter, request.body, request.headers)
}

describe('Resend events through processEmailWebhook', () => {
  it('records email.suppressed as a failed message with PROVIDER_SUPPRESSED, and no local suppression', async () => {
    const message = await insertTestMessage(PREFIX)

    await apply(resendRequest('email.suppressed', message.header))

    expect(
      await sql`select status, failure_origin from email_messages where id = ${message.id}`
    ).toEqual([{ status: 'failed', failure_origin: 'provider' }])
    expect(
      await sql`select type, detail from email_events where message_id = ${message.id}`
    ).toEqual([{ type: 'failed', detail: 'PROVIDER_SUPPRESSED' }])
    expect(
      await sql`select 1 from email_suppressions where address = ${message.recipient.toLowerCase()}`
    ).toHaveLength(0)
  })

  it('suppresses on a Permanent bounce and stores its subType as the detail', async () => {
    const message = await insertTestMessage(PREFIX)

    await apply(
      resendRequest('email.bounced', message.header, {
        bounce: { type: 'Permanent', subType: 'General', message: 'free text' },
      })
    )

    expect(await sql`select status from email_messages where id = ${message.id}`).toEqual([
      { status: 'bounced' },
    ])
    expect(
      await sql`select bounce_kind, detail from email_events where message_id = ${message.id}`
    ).toEqual([{ bounce_kind: 'hard', detail: 'GENERAL' }])
    expect(
      await sql`select reason from email_suppressions where address = ${message.recipient.toLowerCase()}`
    ).toEqual([{ reason: 'hard_bounce' }])
  })

  it('defers on a Transient bounce and suppresses nothing', async () => {
    const message = await insertTestMessage(PREFIX)

    await apply(
      resendRequest('email.bounced', message.header, {
        bounce: { type: 'Transient', subType: 'MailboxFull' },
      })
    )

    expect(await sql`select status from email_messages where id = ${message.id}`).toEqual([
      { status: 'deferred' },
    ])
    expect(
      await sql`select 1 from email_suppressions where address = ${message.recipient.toLowerCase()}`
    ).toHaveLength(0)
  })

  it('stores a redelivered svix-id once', async () => {
    const message = await insertTestMessage(PREFIX)
    const svixId = `msg_${randomBytes(10).toString('hex')}`

    const first = await apply(resendRequest('email.delivered', message.header, {}, svixId))
    const second = await apply(resendRequest('email.delivered', message.header, {}, svixId))

    expect(first.processed).toBe(1)
    expect(second).toMatchObject({ duplicate: 1, processed: 0 })
    expect(
      await sql`select provider, provider_event_id from email_events where message_id = ${message.id}`
    ).toEqual([{ provider: 'resend', provider_event_id: svixId }])
  })

  it('counts email.sent as ignored and changes nothing', async () => {
    const message = await insertTestMessage(PREFIX, { status: 'queued' })

    const result = await apply(resendRequest('email.sent', message.header))

    expect(result).toMatchObject({ received: 1, ignored: 1, processed: 0 })
    expect(await sql`select status from email_messages where id = ${message.id}`).toEqual([
      { status: 'queued' },
    ])
  })
})
