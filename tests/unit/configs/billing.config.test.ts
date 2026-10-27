/**
 * @file The billing provider config takes the env as an argument, so every
 * case here is a crafted env, never the memoised getEnv().
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  billingProviderConfig,
  gstEffectiveFromSetting,
  isGstRegistered,
} from '@/configs/billing.config'
import { parseEnv } from '@/configs/env.config'

const base: Record<string, string> = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
}

/**
 * Parse a crafted environment: the base plus the given raw variables.
 */
function env(extra: Record<string, string>): ReturnType<typeof parseEnv> {
  return parseEnv({ ...base, ...extra })
}

describe('billingProviderConfig', () => {
  it('is null when no Razorpay key and no fake provider', () => {
    expect(billingProviderConfig(env({}))).toBeNull()
  })

  it('returns razorpay test mode for rzp_test_ keys with both webhook secrets in order', () => {
    expect(
      billingProviderConfig(
        env({
          RAZORPAY_KEY_ID: 'rzp_test_A1',
          RAZORPAY_KEY_SECRET: 's',
          RAZORPAY_WEBHOOK_SECRET: 'w2',
          RAZORPAY_WEBHOOK_SECRET_PREVIOUS: 'w1',
        })
      )
    ).toMatchObject({
      kind: 'razorpay',
      mode: 'test',
      keyId: 'rzp_test_A1',
      keySecret: 's',
      webhookSecrets: ['w2', 'w1'],
    })
  })

  it('returns live mode for rzp_live_ keys and one webhook secret when none is rotated', () => {
    expect(
      billingProviderConfig(
        env({
          RAZORPAY_KEY_ID: 'rzp_live_A1',
          RAZORPAY_KEY_SECRET: 's',
          RAZORPAY_WEBHOOK_SECRET: 'w2',
        })
      )
    ).toMatchObject({ mode: 'live', webhookSecrets: ['w2'] })
  })

  it('is null for a partial key set', () => {
    expect(billingProviderConfig(env({ RAZORPAY_KEY_ID: 'rzp_test_A1' }))).toBeNull()
  })

  it('returns the fake provider in test mode', () => {
    expect(billingProviderConfig(env({ BILLING_FAKE_PROVIDER: 'true' }))).toMatchObject({
      kind: 'fake',
      mode: 'test',
      keyId: 'rzp_test_FAKE',
    })
  })

  it('rejects a key id that is not a Razorpay key', () => {
    expect(() => env({ RAZORPAY_KEY_ID: 'sk_live_abc' })).toThrow(/RAZORPAY_KEY_ID/)
  })
})

describe('isGstRegistered', () => {
  it('defaults to false and reads BILLING_GST_REGISTERED', () => {
    expect(isGstRegistered(env({}))).toBe(false)
    expect(isGstRegistered(env({ BILLING_GST_REGISTERED: 'true' }))).toBe(true)
  })
})

describe('gstEffectiveFromSetting', () => {
  it('reads the date whether or not registration is on, and null when unset', () => {
    expect(gstEffectiveFromSetting(env({ BILLING_GST_EFFECTIVE_FROM: '2026-04-01' }))).toBe(
      '2026-04-01'
    )
    expect(gstEffectiveFromSetting(env({}))).toBeNull()
  })
})
