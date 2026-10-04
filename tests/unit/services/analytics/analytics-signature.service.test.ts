/**
 * @file signAnalyticsEvent and isAnalyticsSignatureValid: the canonical string
 * and key pinned against node:crypto, every signed field tamper-evident, a
 * malformed signature refused, and a rotated `SESSION_SECRET` turning old
 * signatures unverified. The secret comes from a mocked `getEnv()`.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isAnalyticsSignatureValid,
  resetAnalyticsSigningKey,
  signAnalyticsEvent,
  type SignedEventFields,
} from '@/services/analytics/analytics-signature.service'

const secret = vi.hoisted(() => ({ value: 's'.repeat(40) }))

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), SESSION_SECRET: secret.value }) }
})

// eslint-disable-next-line unicorn/no-null -- the signer's "absent"
const NONE = null

const FIELDS: SignedEventFields = {
  uuid: '0199a1b2-0000-7000-8000-0000000000a1',
  event: 'user_deactivated',
  distinctId: '0199a1b2-0000-7000-8000-000000000001',
  source: 'audit',
  access: 'platform',
  targetType: 'user',
  targetId: '0199a1b2-0000-7000-8000-000000000002',
  tenant: '0199a1b2-0000-7000-8000-000000000003',
}

afterEach(() => {
  secret.value = 's'.repeat(40)
  resetAnalyticsSigningKey()
})

describe('signAnalyticsEvent', () => {
  it('is the first 32 hex characters of HMAC-SHA256 over the eight fields, under the HKDF key', () => {
    const key = Buffer.from(
      hkdfSync('sha256', secret.value, '', 'analytics-event-signature-v1', 32)
    )
    const expected = createHmac('sha256', key)
      .update(
        [
          FIELDS.uuid,
          FIELDS.event,
          FIELDS.distinctId,
          'audit',
          'platform',
          'user',
          FIELDS.targetId,
          FIELDS.tenant,
        ].join('\n')
      )
      .digest('hex')
      .slice(0, 32)

    expect(signAnalyticsEvent(FIELDS)).toBe(expected)
    expect(signAnalyticsEvent(FIELDS)).toMatch(/^[\da-f]{32}$/)
  })

  it('signs an absent field as the empty string', () => {
    expect(signAnalyticsEvent({ ...FIELDS, tenant: NONE, access: NONE })).toBe(
      signAnalyticsEvent({ ...FIELDS, tenant: '', access: '' })
    )
  })
})

describe('isAnalyticsSignatureValid', () => {
  it('verifies its own signature', () => {
    expect(isAnalyticsSignatureValid(FIELDS, signAnalyticsEvent(FIELDS))).toBe(true)
  })

  it.each([
    ['uuid', { uuid: '0199a1b2-0000-7000-8000-0000000000a2' }],
    ['event', { event: 'user_reactivated' }],
    ['distinctId', { distinctId: '0199a1b2-0000-7000-8000-000000000009' }],
    ['source', { source: 'product' }],
    ['access', { access: 'member' }],
    ['targetType', { targetType: 'tenant' }],
    ['targetId', { targetId: '0199a1b2-0000-7000-8000-000000000008' }],
    ['tenant', { tenant: NONE }],
  ] as const)('refuses the signature once %s is changed', (_field, change) => {
    const signature = signAnalyticsEvent(FIELDS)

    expect(isAnalyticsSignatureValid({ ...FIELDS, ...change }, signature)).toBe(false)
  })

  it('cannot be fooled by moving a value across the newline boundary', () => {
    const signature = signAnalyticsEvent(FIELDS)

    expect(
      isAnalyticsSignatureValid({ ...FIELDS, source: 'audit\nplatform', access: NONE }, signature)
    ).toBe(false)
  })

  it.each([
    ['a shorter string', 'abc'],
    ['a longer string', 'a'.repeat(64)],
    ['an empty string', ''],
    ['a number', 123],
    ['null', NONE],
    ['undefined', undefined],
    ['an array', ['a'.repeat(32)]],
  ])('refuses %s', (_name, signature) => {
    expect(isAnalyticsSignatureValid(FIELDS, signature)).toBe(false)
  })

  it('refuses a 32-character signature that is not this one', () => {
    expect(isAnalyticsSignatureValid(FIELDS, '0'.repeat(32))).toBe(false)
  })

  it('refuses an old signature once SESSION_SECRET rotates', () => {
    const signature = signAnalyticsEvent(FIELDS)

    secret.value = 'r'.repeat(40)
    resetAnalyticsSigningKey()

    expect(isAnalyticsSignatureValid(FIELDS, signature)).toBe(false)
    expect(isAnalyticsSignatureValid(FIELDS, signAnalyticsEvent(FIELDS))).toBe(true)
  })
})
