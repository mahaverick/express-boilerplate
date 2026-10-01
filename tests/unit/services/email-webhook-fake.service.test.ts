/**
 * @file The fake adapter's signature check and parser, pure: every test
 * signs with a secret generated here, never the default.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebhookPayloadError, WebhookSignatureError } from '@/errors/webhook-errors'
import {
  createFakeEmailWebhookAdapter,
  FAKE_SIGNATURE_HEADER,
  fakeEmailWebhookSignature,
} from '@/services/email-webhook-fake.service'

const secret = randomBytes(16).toString('hex')
const NOW = new Date('2026-09-30T12:00:00.000Z')
const adapter = createFakeEmailWebhookAdapter({ secret, now: () => NOW })

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

function signed(raw: Buffer): Record<string, string> {
  // Computed independently of the module under test, so a wrong algorithm there fails here.
  return { [FAKE_SIGNATURE_HEADER]: createHmac('sha256', secret).update(raw).digest('hex') }
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

describe('fake adapter: verify', () => {
  it('signs as lowercase hex HMAC-SHA256 of the raw body', () => {
    const raw = body({ id: 'e1' })
    expect(fakeEmailWebhookSignature(raw, secret)).toBe(signed(raw)[FAKE_SIGNATURE_HEADER])
  })

  it('accepts a body signed with the secret', () => {
    const raw = body({ id: 'e1' })
    expect(rejection(() => adapter.verify(raw, signed(raw)))).toBeUndefined()
  })

  it('refuses a missing, repeated or malformed signature', () => {
    const raw = body({ id: 'e1' })
    expect(rejection(() => adapter.verify(raw, {}))).toBe('missing_headers')
    const value = signed(raw)[FAKE_SIGNATURE_HEADER] ?? ''
    expect(rejection(() => adapter.verify(raw, { [FAKE_SIGNATURE_HEADER]: [value, value] }))).toBe(
      'missing_headers'
    )
    expect(rejection(() => adapter.verify(raw, { [FAKE_SIGNATURE_HEADER]: 'zz' }))).toBe(
      'malformed_headers'
    )
  })

  it('refuses a signature over other bytes, or with another secret', () => {
    const raw = body({ id: 'e1' })
    expect(rejection(() => adapter.verify(body({ id: 'e2' }), signed(raw)))).toBe(
      'signature_mismatch'
    )
    const other = createFakeEmailWebhookAdapter({ secret: randomBytes(16).toString('hex') })
    expect(rejection(() => other.verify(raw, signed(raw)))).toBe('signature_mismatch')
  })

  it('is enabled only with a secret', () => {
    expect(adapter.isEnabled()).toBe(true)
    expect(createFakeEmailWebhookAdapter({ secret: '' }).isEnabled()).toBe(false)
  })
})

describe('fake adapter: parse', () => {
  it('reads one event, keeping the Message-ID brackets and the given time', () => {
    const parsed = adapter.parse(
      body({
        id: 'e1',
        type: 'delivered',
        messageId: '<m1@example.test>',
        occurredAt: '2026-09-30T11:00:00.000Z',
      }),
      {}
    )
    expect(parsed).toEqual({
      events: [
        {
          providerEventId: 'e1',
          messageIdHeader: '<m1@example.test>',
          type: 'delivered',
          occurredAt: new Date('2026-09-30T11:00:00.000Z'),
        },
      ],
      ignored: 0,
    })
  })

  it('reads an array, stamps a missing time with now, and defaults a bounce to hard', () => {
    const parsed = adapter.parse(
      body([
        { id: 'e1', type: 'bounced', messageId: 'm1@example.test' },
        { id: 'e2', type: 'bounced', messageId: '<m1@example.test>', bounceKind: 'soft' },
      ]),
      {}
    )
    expect(parsed.events.map((event) => [event.bounceKind, event.messageIdHeader])).toEqual([
      ['hard', '<m1@example.test>'],
      ['soft', '<m1@example.test>'],
    ])
    expect(parsed.events[0]?.occurredAt).toEqual(NOW)
  })

  it('drops a bounce kind from an event that is not a bounce', () => {
    const [event] = adapter.parse(
      body({ id: 'e1', type: 'delivered', messageId: '<m1@example.test>', bounceKind: 'hard' }),
      {}
    ).events
    expect(event).not.toHaveProperty('bounceKind')
  })

  it('counts an unknown type or a malformed item as ignored', () => {
    const parsed = adapter.parse(
      body([
        { id: 'e1', type: 'sent', messageId: '<m1@example.test>' },
        { id: 'e2', type: 'delivered' },
        { id: '', type: 'delivered', messageId: '<m1@example.test>' },
        'delivered',
        { id: 'e3', type: 'opened', messageId: '<m1@example.test>' },
      ]),
      {}
    )
    expect(parsed.ignored).toBe(4)
    expect(parsed.events.map((event) => event.type)).toEqual(['opened'])
  })

  it('throws WebhookPayloadError for a body that is not JSON', () => {
    expect(() => adapter.parse(Buffer.from('not json'), {})).toThrow(WebhookPayloadError)
  })
})
