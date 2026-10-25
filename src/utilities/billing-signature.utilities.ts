/**
 * @file Razorpay's two signatures, shared by the real and the fake provider:
 * a checkout signature is HMAC-SHA256 over `payment_id|subscription_id` with
 * the key secret, and a webhook signature is HMAC-SHA256 over the raw body
 * with a webhook secret, both lowercase hex. Each check compares in constant
 * time after a length check, so a short, long or empty signature is refused.
 */
import { createHmac } from 'node:crypto'
import type { CheckoutConfirm } from '@/types/billing'
import { isSameSignature } from '@/utilities/email-webhook.utilities'

/**
 * The checkout signature Razorpay sends for a payment on a subscription.
 * @param paymentId - The payment id.
 * @param subscriptionId - The subscription id.
 * @param keySecret - The key secret.
 * @returns The lowercase hex signature.
 */
export function checkoutSignature(
  paymentId: string,
  subscriptionId: string,
  keySecret: string
): string {
  return createHmac('sha256', keySecret).update(`${paymentId}|${subscriptionId}`).digest('hex')
}

/**
 * Whether a received hex signature equals the expected one. Both are compared
 * as text bytes, so odd or invalid hex fails the length check rather than
 * being truncated by a hex decode.
 * @param expected - The computed signature.
 * @param received - The signature the request carried.
 * @returns True only for identical text.
 */
function isSameHex(expected: string, received: string): boolean {
  return isSameSignature(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
}

/**
 * Whether a checkout was signed for the expected subscription. The posted
 * subscription id must equal the expected one, and the signature is computed
 * over the expected id, never the posted one. A field that is not a
 * non-empty string answers false, never a throw.
 * @param input - What the browser posted.
 * @param expectedSubscriptionId - The subscription the checkout must be for.
 * @param keySecret - The key secret.
 * @returns True for a matching signature over the expected subscription.
 */
export function isValidCheckoutSignature(
  input: { readonly [Key in keyof CheckoutConfirm]: unknown },
  expectedSubscriptionId: string,
  keySecret: string
): boolean {
  const {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature,
  } = input
  if (typeof paymentId !== 'string' || typeof signature !== 'string') return false
  if (subscriptionId !== expectedSubscriptionId) return false
  if (signature === '' || paymentId === '' || expectedSubscriptionId === '') return false
  const expected = checkoutSignature(paymentId, expectedSubscriptionId, keySecret)
  return isSameHex(expected, signature)
}

/**
 * Whether a webhook body was signed with any of the secrets. Every secret is
 * tried, so the time does not reveal which one matched.
 * @param rawBody - The exact request bytes.
 * @param signature - The signature header, if any.
 * @param secrets - The current secret, then the previous one during a rotation.
 * @returns True when one secret's signature matches.
 */
export function isValidWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secrets: readonly string[]
): boolean {
  if (signature === undefined || signature === '') return false
  let isMatch = false
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    if (isSameHex(expected, signature)) isMatch = true
  }
  return isMatch
}
