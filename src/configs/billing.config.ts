/**
 * @file Which payment provider the app talks to, and whether it is on. Every
 * function takes the env as an argument so tests pass a crafted one; the
 * default is the validated `getEnv()`.
 */
import { getEnv, type Env } from '@/configs/env.config'
import type { BillingProvider, BillingProviderMode } from '@/constants/billing.constants'

/**
 * Credentials and mode of the configured payment provider.
 */
export interface BillingProviderConfig {
  /**
   * Which provider answers.
   */
  kind: BillingProvider
  /**
   * Test or live, from the key id's prefix.
   */
  mode: BillingProviderMode
  /**
   * The Razorpay key id.
   */
  keyId: string
  /**
   * The Razorpay key secret.
   */
  keySecret: string
  /**
   * Secrets a webhook signature may verify against, current first.
   */
  webhookSecrets: string[]
}

/**
 * The slice of the environment the billing config reads.
 */
type BillingEnv = Pick<
  Env,
  | 'RAZORPAY_KEY_ID'
  | 'RAZORPAY_KEY_SECRET'
  | 'RAZORPAY_WEBHOOK_SECRET'
  | 'RAZORPAY_WEBHOOK_SECRET_PREVIOUS'
  | 'BILLING_FAKE_PROVIDER'
  | 'BILLING_GST_REGISTERED'
>

/**
 * The payment provider settings.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns The provider's credentials, or null when payments are off (no keys and no fake).
 */
export function billingProviderConfig(env: BillingEnv = getEnv()): BillingProviderConfig | null {
  if (env.BILLING_FAKE_PROVIDER) {
    return {
      kind: 'fake',
      mode: 'test',
      keyId: 'rzp_test_FAKE',
      keySecret: 'fake_key_secret',
      webhookSecrets: ['fake_webhook_secret'],
    }
  }
  const { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret } = env
  const current = env.RAZORPAY_WEBHOOK_SECRET
  if (keyId === undefined || keySecret === undefined || current === undefined) return null
  const previous = env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS
  return {
    kind: 'razorpay',
    mode: keyId.startsWith('rzp_live_') ? 'live' : 'test',
    keyId,
    keySecret,
    webhookSecrets: previous === undefined ? [current] : [current, previous],
  }
}

/**
 * Whether the business is registered for GST.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns True when prices carry a GST line.
 */
export function isGstRegistered(env: BillingEnv = getEnv()): boolean {
  return env.BILLING_GST_REGISTERED
}
