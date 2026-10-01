/**
 * @file POST /api/v1/webhooks/email/:provider through the real app and
 * database, with the fake adapter (the suite runs as APP_ENV local, and sets
 * no RESEND_WEBHOOK_SECRET). Covers the wiring (raw bytes ahead of
 * express.json, the request id on the log line, 404/401/413/400), and the
 * processing rules: deduplication, status precedence, soft and hard bounces,
 * suppression, unmatched and ignored counts, and a failed request's retry.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import { sql } from '@/services/database.service'
import { fakeEmailWebhookSignature } from '@/services/email-webhook-fake.service'
import { logger } from '@/services/logger.service'
import { requestContextStore } from '@/services/request-context.service'
import {
  deleteTrackingRows,
  insertTestMessage,
  signedFakeBody,
  type FakeEvent,
} from '../../helpers/email-tracking'
import { withMutatedMethod } from '../../helpers/mutate'
import { request } from '../../helpers/request'

const app = createApp()
const PREFIX = `webhook-${randomUUID()}-`
const FAKE_URL = '/api/v1/webhooks/email/fake'
const emailMessageRepository = new EmailMessageRepository()

afterEach(async () => {
  vi.restoreAllMocks()
  await deleteTrackingRows(PREFIX)
})

/**
 * Post signed fake events.
 * @param events - One event or several.
 * @returns The response.
 */
function fire(events: FakeEvent | FakeEvent[]): Promise<Response> {
  const { body, headers } = signedFakeBody(events)
  return request(app).post(FAKE_URL).set(headers).send(body.toString('utf8'))
}

/**
 * A message's current status and failure origin.
 * @param id - The message id.
 * @returns The two columns.
 */
async function statusOf(id: string): Promise<{ status: string; failure_origin: string | null }> {
  const [row] = await sql<{ status: string; failure_origin: string | null }[]>`
    select status, failure_origin from email_messages where id = ${id}`
  if (!row) throw new Error('message not found')
  return row
}

/**
 * A message's current status.
 * @param id - The message id.
 * @returns The status.
 */
async function currentStatus(id: string): Promise<string> {
  const { status } = await statusOf(id)
  return status
}

/**
 * The events stored for a message, oldest first.
 * @param id - The message id.
 * @returns Each event's type, bounce kind and provider event id.
 */
function eventsOf(id: string) {
  return sql<{ type: string; bounce_kind: string | null; provider_event_id: string }[]>`
    select type, bounce_kind, provider_event_id from email_events
    where message_id = ${id} order by received_at, id`
}

/**
 * The suppressions held for an address.
 * @param address - The recipient.
 * @returns Each row's reason, whether it is active, and its source event.
 */
function suppressionsOf(address: string) {
  return sql<{ reason: string; is_active: boolean; source_event_id: string | null }[]>`
    select reason, lifted_at is null as is_active, source_event_id from email_suppressions
    where address = ${address.toLowerCase()}`
}

describe('webhook wiring', () => {
  it('verifies the exact bytes sent as application/json, before express.json parses them', async () => {
    const message = await insertTestMessage(PREFIX)
    // Whitespace and key order a JSON round-trip would not reproduce: the signature covers these bytes.
    const body = Buffer.from(
      `{ "type":"delivered",\n  "messageId" : "${message.header}", "id":"evt-${randomUUID()}" }`
    )
    const { headers } = signedFakeBody({ type: 'delivered', messageId: message.header })
    headers['x-fake-signature'] = fakeEmailWebhookSignature(
      body,
      getEnv().FAKE_EMAIL_WEBHOOK_SECRET
    )

    // As a string: superagent JSON-encodes a Buffer sent as application/json.
    const response = await request(app).post(FAKE_URL).set(headers).send(body.toString('utf8'))

    expect(response.status).toBe(200)
    expect((response.body as { data: { processed: number } }).data.processed).toBe(1)
    expect(await currentStatus(message.id)).toBe('delivered')
  })

  it('logs one "email webhook processed" line carrying the request id', async () => {
    const message = await insertTestMessage(PREFIX)
    const seen: { meta: unknown; requestId: string | undefined }[] = []
    vi.spyOn(logger, 'info').mockImplementation((line, meta) => {
      if (line === 'email webhook processed') {
        seen.push({ meta, requestId: requestContextStore.getStore()?.requestId })
      }
    })

    const response = await fire({ type: 'opened', messageId: message.header })

    expect(response.status).toBe(200)
    expect(seen).toEqual([
      {
        meta: {
          provider: 'fake',
          received: 1,
          duplicate: 0,
          unmatched: 0,
          ignored: 0,
          processed: 1,
          byType: { opened: 1 },
        },
        requestId: response.headers['x-request-id'] as string,
      },
    ])
  })

  it('answers 200 with the per-provider limiter headers', async () => {
    const message = await insertTestMessage(PREFIX)
    const response = await fire({ type: 'delivered', messageId: message.header })
    expect(response.status).toBe(200)
    expect(response.headers['ratelimit-limit']).toBe('3000')
  })

  it.each(['resend', 'nope', 'FAKE'])(
    "answers %s with the app's own 404 and no rate-limit headers",
    async (provider) => {
      const { body, headers } = signedFakeBody({ type: 'delivered', messageId: '<x@example.test>' })
      const response = await request(app)
        .post(`/api/v1/webhooks/email/${provider}`)
        .set(headers)
        .send(body)
      const unknownRoute = await request(app).post('/api/v1/nope').send({})

      expect(response.status).toBe(404)
      expect(response.headers['ratelimit-limit']).toBeUndefined()
      expect(response.body).toEqual({
        ...(unknownRoute.body as Record<string, unknown>),
        requestId: response.headers['x-request-id'] as string,
      })
    }
  )

  it('answers a bad signature 401 INVALID_SIGNATURE and logs a warning without the payload', async () => {
    const message = await insertTestMessage(PREFIX)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { body, headers } = signedFakeBody({ type: 'delivered', messageId: message.header })

    const response = await request(app)
      .post(FAKE_URL)
      .set({ ...headers, 'x-fake-signature': '0'.repeat(64) })
      .send(body)

    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ statusCode: 401, code: 'INVALID_SIGNATURE' })
    expect(warn).toHaveBeenCalledWith('email webhook signature rejected', {
      provider: 'fake',
      reason: 'signature_mismatch',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(message.header)
    expect(await currentStatus(message.id)).toBe('sent')
  })

  it('answers 401 to an unsigned request and to one with no body', async () => {
    const missing = await request(app)
      .post(FAKE_URL)
      .set('Content-Type', 'application/json')
      .send('{}')
    expect(missing.status).toBe(401)
    const empty = await request(app).post(FAKE_URL)
    expect(empty.status).toBe(401)
  })

  it('answers 413 for a body over 256kb', async () => {
    const { headers } = signedFakeBody({ type: 'delivered', messageId: '<x@example.test>' })
    const response = await request(app)
      .post(FAKE_URL)
      .set(headers)
      .send('a'.repeat(257 * 1024))
    expect(response.status).toBe(413)
  })

  it('answers a signed body that is not JSON 400 INVALID_PAYLOAD', async () => {
    const body = Buffer.from('not json')
    const response = await request(app)
      .post(FAKE_URL)
      .set('Content-Type', 'text/plain')
      .set('x-fake-signature', fakeEmailWebhookSignature(body, getEnv().FAKE_EMAIL_WEBHOOK_SECRET))
      .send(body)
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'INVALID_PAYLOAD' })
  })
})

describe('webhook processing', () => {
  it('stores a redelivered provider event once', async () => {
    const message = await insertTestMessage(PREFIX)
    const event: FakeEvent = {
      id: `evt-${randomUUID()}`,
      type: 'delivered',
      messageId: message.header,
    }

    const first = await fire(event)
    const second = await fire(event)

    expect((first.body as { data: { processed: number } }).data.processed).toBe(1)
    expect((second.body as { data: { duplicate: number; processed: number } }).data).toMatchObject({
      duplicate: 1,
      processed: 0,
    })
    expect(await eventsOf(message.id)).toHaveLength(1)
  })

  it('keeps precedence when events arrive out of order, and a late sent never overwrites delivered', async () => {
    const message = await insertTestMessage(PREFIX, { status: 'queued' })

    await fire({ type: 'delivered', messageId: message.header })
    await fire({ type: 'deferred', messageId: message.header })

    expect(await currentStatus(message.id)).toBe('delivered')
    expect(await emailMessageRepository.advanceStatus(message.id, 'sent')).toBe(false)
    expect(await currentStatus(message.id)).toBe('delivered')
    expect(await eventsOf(message.id)).toMatchObject([{ type: 'delivered' }, { type: 'deferred' }])
  })

  it('treats a soft bounce as a delay: deferred, no suppression, and delivered still lands', async () => {
    const message = await insertTestMessage(PREFIX)

    await fire({ type: 'bounced', bounceKind: 'soft', messageId: message.header })
    expect(await currentStatus(message.id)).toBe('deferred')
    expect(await eventsOf(message.id)).toMatchObject([{ type: 'bounced', bounce_kind: 'soft' }])
    expect(await suppressionsOf(message.recipient)).toEqual([])

    await fire({ type: 'delivered', messageId: message.header })
    expect(await currentStatus(message.id)).toBe('delivered')
  })

  it('suppresses on a hard bounce, once, pointing at the event', async () => {
    const message = await insertTestMessage(PREFIX, { recipient: `${PREFIX}Mixed@Example.test` })

    await fire({ type: 'bounced', bounceKind: 'hard', messageId: message.header })
    await fire({ type: 'bounced', bounceKind: 'hard', messageId: message.header })

    expect(await currentStatus(message.id)).toBe('bounced')
    const [first] = await sql<{ id: string }[]>`
      select id from email_events where message_id = ${message.id} order by received_at, id limit 1`
    expect(await suppressionsOf(message.recipient)).toEqual([
      { reason: 'hard_bounce', is_active: true, source_event_id: first?.id },
    ])
    expect(await new EmailSuppressionRepository().findActive(message.recipient)).toBeDefined()
  })

  it('suppresses on a complaint, and a complaint outranks delivered', async () => {
    const message = await insertTestMessage(PREFIX, { status: 'delivered' })

    await fire({ type: 'complained', messageId: message.header })

    expect(await currentStatus(message.id)).toBe('complained')
    expect(await suppressionsOf(message.recipient)).toMatchObject([
      { reason: 'complaint', is_active: true },
    ])
  })

  it('marks a provider failure with failure_origin provider, and suppresses nothing', async () => {
    const message = await insertTestMessage(PREFIX)

    await fire({ type: 'failed', messageId: message.header })

    expect(await statusOf(message.id)).toEqual({ status: 'failed', failure_origin: 'provider' })
    expect(await suppressionsOf(message.recipient)).toEqual([])
  })

  it('stores opens and clicks without moving the status', async () => {
    const message = await insertTestMessage(PREFIX)

    const response = await fire([
      { type: 'opened', messageId: message.header },
      { type: 'clicked', messageId: message.header },
    ])

    expect((response.body as { data: unknown }).data).toMatchObject({
      processed: 2,
      byType: { opened: 1, clicked: 1 },
    })
    expect(await currentStatus(message.id)).toBe('sent')
    expect(await eventsOf(message.id)).toHaveLength(2)
  })

  it('answers 200 for an unmatched Message-ID, counting it and storing nothing', async () => {
    const header = `<${randomUUID()}@nowhere.example.test>`

    const response = await fire({ type: 'delivered', messageId: header })

    expect(response.status).toBe(200)
    expect((response.body as { data: unknown }).data).toEqual({
      received: 1,
      duplicate: 0,
      unmatched: 1,
      ignored: 0,
      processed: 0,
      byType: {},
    })
  })

  it('counts every event of a mixed request exactly once', async () => {
    const message = await insertTestMessage(PREFIX)
    const repeated: FakeEvent = {
      id: `evt-${randomUUID()}`,
      type: 'delivered',
      messageId: message.header,
    }

    const response = await fire([
      repeated,
      repeated,
      { type: 'sent', messageId: message.header },
      { type: 'opened', messageId: `<${randomUUID()}@nowhere.example.test>` },
    ])

    expect((response.body as { data: unknown }).data).toEqual({
      received: 4,
      duplicate: 1,
      unmatched: 1,
      ignored: 1,
      processed: 1,
      byType: { delivered: 1 },
    })
  })

  it('answers 500 when a write fails, rolls the whole request back, and applies the retry once', async () => {
    const message = await insertTestMessage(PREFIX)
    const event: FakeEvent = {
      id: `evt-${randomUUID()}`,
      type: 'bounced',
      bounceKind: 'hard',
      messageId: message.header,
    }
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    await withMutatedMethod(
      EmailSuppressionRepository.prototype,
      'suppress',
      () => Promise.reject(new Error('injected suppression failure')),
      async () => {
        const failed = await fire(event)
        expect(failed.status).toBe(500)
      }
    )
    // The event insert rolled back with the failed suppression, so the retry is not a duplicate.
    expect(await eventsOf(message.id)).toEqual([])
    expect(await currentStatus(message.id)).toBe('sent')

    const retried = await fire(event)

    expect(retried.status).toBe(200)
    expect((retried.body as { data: { processed: number } }).data.processed).toBe(1)
    expect(await eventsOf(message.id)).toHaveLength(1)
    expect(await currentStatus(message.id)).toBe('bounced')
    expect(await suppressionsOf(message.recipient)).toHaveLength(1)
  })
})
