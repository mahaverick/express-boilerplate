/**
 * @file The Resend adapter against fixtures signed here, at test time, with
 * a secret generated per run: the Svix scheme is re-implemented below with
 * node:crypto, independently of the module under test, so a wrong signed
 * string, key decoding or encoding there fails here. No literal secret or
 * signature is committed.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebhookPayloadError, WebhookSignatureError } from '@/errors/webhook-errors'
import {
  createResendEmailWebhookAdapter,
  RESEND_SIGNATURE_TOLERANCE_MS,
} from '@/services/email-webhook-resend.service'

const key = randomBytes(24)
const secret = `whsec_${key.toString('base64')}`
const NOW_MS = Date.UTC(2026, 8, 30, 12, 0, 0)
const NOW_SECONDS = String(NOW_MS / 1000)
const adapter = createResendEmailWebhookAdapter({ secret, now: () => NOW_MS })

function svixSignature(signingKey: Buffer, id: string, timestamp: string, raw: Buffer): string {
  const digest = createHmac('sha256', signingKey)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]))
    .digest('base64')
  return `v1,${digest}`
}

function signedHeaders(
  raw: Buffer,
  overrides: { id?: string; timestamp?: string; signature?: string } = {}
): Record<string, string> {
  const id = overrides.id ?? `msg_${randomBytes(8).toString('hex')}`
  const timestamp = overrides.timestamp ?? NOW_SECONDS
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': overrides.signature ?? svixSignature(key, id, timestamp, raw),
  }
}

function resendBody(type: string, data: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      created_at: '2026-09-30T11:59:30.000Z',
      data: {
        email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
        created_at: '2026-09-30T11:59:00.000Z',
        from: 'Acme <no-reply@example.test>',
        to: ['someone@example.test'],
        subject: 'Verify your email',
        message_id: '<0192f0a0-0000-7000-8000-000000000001@mail.example.test>',
        ...data,
      },
    })
  )
}

function rejection(run: () => void): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason
    throw error
  }
  return undefined
}

describe('Resend adapter: verify', () => {
  it('accepts a body signed with the secret', () => {
    const raw = resendBody('email.delivered')
    expect(rejection(() => adapter.verify(raw, signedHeaders(raw)))).toBeUndefined()
  })

  it('accepts any matching v1 entry of several, as during a secret rotation', () => {
    const raw = resendBody('email.delivered')
    const headers = signedHeaders(raw)
    const other = svixSignature(randomBytes(24), 'x', NOW_SECONDS, raw)
    headers['svix-signature'] = `v2,ignored ${other} ${headers['svix-signature'] ?? ''}`
    expect(rejection(() => adapter.verify(raw, headers))).toBeUndefined()
  })

  it('refuses a signature over other bytes, another id, or with another key', () => {
    const raw = resendBody('email.delivered')
    const headers = signedHeaders(raw)
    expect(rejection(() => adapter.verify(resendBody('email.bounced'), headers))).toBe(
      'signature_mismatch'
    )
    expect(rejection(() => adapter.verify(raw, { ...headers, 'svix-id': 'msg_other' }))).toBe(
      'signature_mismatch'
    )
    const foreign = svixSignature(randomBytes(24), headers['svix-id'] ?? '', NOW_SECONDS, raw)
    expect(rejection(() => adapter.verify(raw, { ...headers, 'svix-signature': foreign }))).toBe(
      'signature_mismatch'
    )
    expect(
      rejection(() => adapter.verify(raw, { ...headers, 'svix-signature': 'v1,' + 'A'.repeat(44) }))
    ).toBe('signature_mismatch')
  })

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('refuses a missing %s', (name) => {
    const raw = resendBody('email.delivered')
    const headers: Record<string, string> = signedHeaders(raw)
    delete headers[name]
    expect(rejection(() => adapter.verify(raw, headers))).toBe('missing_headers')
  })

  it('refuses a malformed id or timestamp', () => {
    const raw = resendBody('email.delivered')
    expect(rejection(() => adapter.verify(raw, signedHeaders(raw, { id: 'a'.repeat(129) })))).toBe(
      'malformed_headers'
    )
    expect(rejection(() => adapter.verify(raw, signedHeaders(raw, { id: 'msg 1' })))).toBe(
      'malformed_headers'
    )
    expect(
      rejection(() => adapter.verify(raw, signedHeaders(raw, { timestamp: `${NOW_SECONDS}.5` })))
    ).toBe('malformed_headers')
  })

  it('accepts a timestamp at the tolerance and refuses one beyond it, in either direction', () => {
    const raw = resendBody('email.delivered')
    const edge = RESEND_SIGNATURE_TOLERANCE_MS / 1000
    for (const offset of [-edge, edge]) {
      const timestamp = String(NOW_MS / 1000 + offset)
      expect(
        rejection(() => adapter.verify(raw, signedHeaders(raw, { timestamp })))
      ).toBeUndefined()
    }
    for (const offset of [-(edge + 1), edge + 1]) {
      const timestamp = String(NOW_MS / 1000 + offset)
      expect(rejection(() => adapter.verify(raw, signedHeaders(raw, { timestamp })))).toBe(
        'stale_timestamp'
      )
    }
  })

  it('is enabled only with a secret', () => {
    expect(adapter.isEnabled()).toBe(true)
    expect(createResendEmailWebhookAdapter({ secret: undefined }).isEnabled()).toBe(false)
  })
})

function parsedEvent(raw: Buffer) {
  const headers = signedHeaders(raw, { id: 'msg_2mD6fCWlLJzYz1k2aEGb4QYqWnT' })
  return adapter.parse(raw, headers)
}

describe('Resend adapter: parse', () => {
  it.each([
    ['email.delivered', 'delivered'],
    ['email.delivery_delayed', 'deferred'],
    ['email.complained', 'complained'],
    ['email.opened', 'opened'],
    ['email.failed', 'failed'],
  ])('maps %s to %s, with svix-id, created_at and the Message-ID', (resendType, type) => {
    expect(parsedEvent(resendBody(resendType))).toEqual({
      events: [
        {
          providerEventId: 'msg_2mD6fCWlLJzYz1k2aEGb4QYqWnT',
          messageIdHeader: '<0192f0a0-0000-7000-8000-000000000001@mail.example.test>',
          type,
          occurredAt: new Date('2026-09-30T11:59:30.000Z'),
        },
      ],
      ignored: 0,
    })
  })

  it('maps email.clicked to clicked and never carries the link', () => {
    const raw = resendBody('email.clicked', {
      click: { link: 'https://example.test/verify?token=secret-link', ipAddress: '203.0.113.9' },
    })
    const parsed = parsedEvent(raw)
    expect(parsed.events[0]?.type).toBe('clicked')
    expect(JSON.stringify(parsed)).not.toContain('secret-link')
  })

  it('maps email.suppressed to failed with PROVIDER_SUPPRESSED', () => {
    const raw = resendBody('email.suppressed', {
      suppressed: { message: 'on the account suppression list', type: 'OnAccountSuppressionList' },
    })
    expect(parsedEvent(raw).events[0]).toMatchObject({
      type: 'failed',
      detail: 'PROVIDER_SUPPRESSED',
    })
  })

  it.each([
    ['Permanent', 'hard'],
    ['Transient', 'soft'],
    ['Undetermined', 'soft'],
    [undefined, 'soft'],
  ])('reads a %s bounce as %s', (bounceType, bounceKind) => {
    const raw = resendBody('email.bounced', {
      bounce: { type: bounceType, subType: 'MessageRejected', message: 'free text never stored' },
    })
    const [event] = parsedEvent(raw).events
    expect(event).toMatchObject({ type: 'bounced', bounceKind, detail: 'MESSAGE_REJECTED' })
    expect(JSON.stringify(event)).not.toContain('free text')
  })

  it('drops a token-shaped subType rather than storing it', () => {
    const raw = resendBody('email.bounced', {
      bounce: { type: 'Permanent', subType: randomBytes(32).toString('hex') },
    })
    const [event] = parsedEvent(raw).events
    expect(event?.bounceKind).toBe('hard')
    expect(event).not.toHaveProperty('detail')
  })

  it('adds the angle brackets to a bare message_id', () => {
    const raw = resendBody('email.delivered', { message_id: ' abc@mail.example.test ' })
    expect(parsedEvent(raw).events[0]?.messageIdHeader).toBe('<abc@mail.example.test>')
  })

  it.each([
    'email.sent',
    'email.scheduled',
    'email.received',
    'email.something_new',
    'domain.updated',
    'contact.created',
    'suppression.created',
    'topic.updated',
    'inbox.created',
  ])('ignores %s', (resendType) => {
    expect(parsedEvent(resendBody(resendType))).toEqual({ events: [], ignored: 1 })
  })

  it('ignores a tracked type with no message_id or no created_at', () => {
    expect(parsedEvent(resendBody('email.delivered', { message_id: undefined }))).toEqual({
      events: [],
      ignored: 1,
    })
    const raw = Buffer.from(
      JSON.stringify({ type: 'email.delivered', data: { message_id: '<a@b>' } })
    )
    expect(parsedEvent(raw)).toEqual({ events: [], ignored: 1 })
  })

  it('throws WebhookPayloadError for a body that is not JSON', () => {
    expect(() => adapter.parse(Buffer.from('<xml/>'), {})).toThrow(WebhookPayloadError)
  })
})
