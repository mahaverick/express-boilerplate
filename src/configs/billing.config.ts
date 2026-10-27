/**
 * @file Which payment provider the app talks to, and whether it is on. Every
 * function takes the env as an argument so tests pass a crafted one; the
 * default is the validated `getEnv()`.
 */
import { getEnv, type Env } from '@/configs/env.config'
import type { BillingProvider, BillingProviderMode } from '@/constants/billing.constants'
import { istMidnight } from '@/utilities/gst.utilities'

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

/**
 * The slice of the environment the GST seller config reads.
 */
type GstEnv = Pick<
  Env,
  | 'BILLING_GST_REGISTERED'
  | 'BILLING_SELLER_GSTIN'
  | 'BILLING_SELLER_LEGAL_NAME'
  | 'BILLING_SELLER_ADDRESS'
  | 'BILLING_SELLER_STATE_CODE'
  | 'BILLING_SAC_CODE'
  | 'BILLING_GST_EFFECTIVE_FROM'
  | 'BILLING_INVOICE_PREFIX'
  | 'BILLING_CREDIT_NOTE_PREFIX'
>

/**
 * The seller details printed on every tax document.
 */
export interface GstSellerConfig {
  /** The seller's GSTIN. */
  gstin: string
  /** The seller's legal name, in straight quotes. */
  legalName: string
  /** The printed address lines. */
  addressLines: string[]
  /** Two-digit state code of the seller's registration. */
  stateCode: string
  /** The 6-digit SAC code. */
  sacCode: string
  /** The first instant tax documents cover: 00:00 IST on the configured day. */
  effectiveFrom: Date
  /** Prefix of invoice numbers. */
  invoicePrefix: string
  /** Prefix of credit note numbers. */
  creditNotePrefix: string
}

/**
 * The GST seller settings.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns The seller config, or null when the business isn't registered for GST.
 * @throws {Error} When registration is on and a seller setting is missing (boot refuses this first).
 */
export function gstSellerConfig(env: GstEnv = getEnv()): GstSellerConfig | null {
  if (!env.BILLING_GST_REGISTERED) return null
  const gstin = env.BILLING_SELLER_GSTIN
  const legalName = env.BILLING_SELLER_LEGAL_NAME
  const address = env.BILLING_SELLER_ADDRESS
  const stateCode = env.BILLING_SELLER_STATE_CODE
  const sacCode = env.BILLING_SAC_CODE
  const from = env.BILLING_GST_EFFECTIVE_FROM
  if (
    gstin === undefined ||
    legalName === undefined ||
    address === undefined ||
    stateCode === undefined ||
    sacCode === undefined ||
    from === undefined
  ) {
    throw new Error('BILLING_GST_REGISTERED is true but a seller setting is missing.')
  }
  return {
    gstin,
    legalName,
    addressLines: address.split(' | ').map((line) => line.trim()),
    stateCode,
    sacCode,
    effectiveFrom: istMidnight(from),
    invoicePrefix: env.BILLING_INVOICE_PREFIX,
    creditNotePrefix: env.BILLING_CREDIT_NOTE_PREFIX,
  }
}

/**
 * The configured first day tax documents cover, whether or not registration
 * is on, so a server turned off with documents still bounds the export
 * picker.
 * @param env - The settings to read; defaults to the validated environment.
 * @returns The `YYYY-MM-DD` date, or null when unset.
 */
export function gstEffectiveFromSetting(
  env: Pick<Env, 'BILLING_GST_EFFECTIVE_FROM'> = getEnv()
): string | null {
  return env.BILLING_GST_EFFECTIVE_FROM ?? null
}
