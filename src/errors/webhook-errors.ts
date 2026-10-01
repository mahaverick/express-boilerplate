/**
 * @file The two ways an inbound webhook request is refused before any event
 * is applied. Plain errors carrying no HTTP status: `processEmailWebhook`
 * (email-webhook.service.ts) logs each and turns it into the response's
 * `HttpError`.
 */

/**
 * Why a signature check failed, for the `warn` log line only; the client is
 * told nothing beyond `INVALID_SIGNATURE`.
 */
export type WebhookSignatureFailure =
  'missing_headers' | 'malformed_headers' | 'stale_timestamp' | 'signature_mismatch'

/**
 * A webhook request that the provider did not sign, or signed too long ago.
 */
export class WebhookSignatureError extends Error {
  /**
   * @param reason - Which check failed.
   */
  constructor(readonly reason: WebhookSignatureFailure) {
    super(`Webhook signature rejected: ${reason}`)
    this.name = 'WebhookSignatureError'
  }
}

/**
 * A correctly signed webhook body that is not JSON.
 */
export class WebhookPayloadError extends Error {
  /**
   * The message is fixed: the body itself is never quoted.
   */
  constructor() {
    super('Webhook body is not JSON')
    this.name = 'WebhookPayloadError'
  }
}
