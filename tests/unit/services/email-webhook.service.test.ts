/**
 * @file The pure half of webhook processing: which adapters an environment
 * registers, and how a normalised event moves status and suppression. The
 * transaction runs against Postgres in
 * tests/integration/api/email-webhook.test.ts.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '@/configs/env.config'
import {
  emailWebhookAdapters,
  getEmailWebhookAdapter,
  statusChangeFor,
  suppressionReasonFor,
} from '@/services/email-webhook.service'
import type { NormalizedEmailEvent } from '@/types/email-webhook'

function envFor(appEnv: AppEnv) {
  return { APP_ENV: appEnv, FAKE_EMAIL_WEBHOOK_SECRET: 'fake-webhook' }
}

function event(overrides: Partial<NormalizedEmailEvent>): NormalizedEmailEvent {
  return {
    providerEventId: 'e1',
    messageIdHeader: '<m1@example.test>',
    type: 'delivered',
    occurredAt: new Date('2026-09-30T00:00:00.000Z'),
    ...overrides,
  }
}

describe('emailWebhookAdapters', () => {
  it('registers the fake adapter on local', () => {
    expect(emailWebhookAdapters(envFor('local')).map((adapter) => adapter.provider)).toContain(
      'fake'
    )
    expect(getEmailWebhookAdapter('fake', envFor('local'))?.provider).toBe('fake')
  })

  it.each(['dev', 'qa', 'prod'] as const)('never registers the fake adapter on %s', (appEnv) => {
    expect(emailWebhookAdapters(envFor(appEnv)).map((adapter) => adapter.provider)).not.toContain(
      'fake'
    )
    expect(getEmailWebhookAdapter('fake', envFor(appEnv))).toBeUndefined()
  })

  it.each(['local', 'dev', 'qa', 'prod'] as const)(
    'registers Resend on %s, enabled only by RESEND_WEBHOOK_SECRET',
    (appEnv) => {
      const secret = `whsec_${randomBytes(24).toString('base64')}`
      expect(getEmailWebhookAdapter('resend', envFor(appEnv))).toBeUndefined()
      expect(
        getEmailWebhookAdapter('resend', { ...envFor(appEnv), RESEND_WEBHOOK_SECRET: secret })
          ?.provider
      ).toBe('resend')
    }
  )

  it.each(['', 'nope', 'FAKE', 'constructor'])('has no adapter for %j', (provider) => {
    expect(getEmailWebhookAdapter(provider, envFor('local'))).toBeUndefined()
  })
})

describe('statusChangeFor', () => {
  it.each([
    [event({ type: 'delivered' }), { status: 'delivered' }],
    [event({ type: 'deferred' }), { status: 'deferred' }],
    [event({ type: 'complained' }), { status: 'complained' }],
    [event({ type: 'bounced', bounceKind: 'hard' }), { status: 'bounced' }],
    [event({ type: 'bounced', bounceKind: 'soft' }), { status: 'deferred' }],
    [event({ type: 'failed' }), { status: 'failed', failureOrigin: 'provider' }],
  ])('moves %o to %o', (input, expected) => {
    expect(statusChangeFor(input)).toEqual(expected)
  })

  it.each(['opened', 'clicked'] as const)('leaves the status alone on %s', (type) => {
    expect(statusChangeFor(event({ type }))).toBeUndefined()
  })
})

describe('suppressionReasonFor', () => {
  it('suppresses on a hard bounce and a complaint only', () => {
    expect(suppressionReasonFor(event({ type: 'bounced', bounceKind: 'hard' }))).toBe('hard_bounce')
    expect(suppressionReasonFor(event({ type: 'complained' }))).toBe('complaint')
    expect(suppressionReasonFor(event({ type: 'bounced', bounceKind: 'soft' }))).toBeUndefined()
    for (const type of ['delivered', 'deferred', 'opened', 'clicked', 'failed'] as const) {
      expect(suppressionReasonFor(event({ type }))).toBeUndefined()
    }
  })
})
