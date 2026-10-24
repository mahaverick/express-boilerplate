/**
 * @file The error every failed payment-provider call throws. It never reads
 * as a subscription state: a caller that gets one changes nothing and, when
 * it is retryable, tries again later. It carries the HTTP status and the
 * provider's error code, never a request body or a credential. A timeout, a
 * network failure, a 5xx and a 429 (rate limited) are retryable; any other
 * 4xx is not.
 */

/**
 * A payment-provider call that did not succeed: `status` is the HTTP status,
 * `'timeout'` when no answer came in time, or `'network'` when the call never
 * got an answer. `retryable` is true for a timeout, a network failure, a 5xx
 * and a 429, false for any other 4xx.
 */
export class ProviderError extends Error {
  readonly status: number | 'timeout' | 'network'
  readonly retryable: boolean
  /**
   * The provider's error code (Razorpay's `error.code`), when it sent one.
   */
  readonly code: string | undefined
  /**
   * The provider's own description of the error, when it sent one.
   */
  readonly description: string | undefined

  /**
   * @param what - The call that failed, as `METHOD /path`; ids only, never a body.
   * @param status - The HTTP status, `'timeout'` or `'network'`.
   * @param details - The provider's error code and description, if any.
   * @param details.code - The provider's error code.
   * @param details.description - The provider's description.
   * @param options - The underlying error, when one was thrown.
   * @param options.cause - The underlying error.
   */
  constructor(
    what: string,
    status: number | 'timeout' | 'network',
    details: { code?: string | undefined; description?: string | undefined } = {},
    options: { cause?: unknown } = {}
  ) {
    super(`Payment provider call ${what} failed (${String(status)})`, options)
    this.name = 'ProviderError'
    this.status = status
    this.retryable = typeof status !== 'number' || status >= 500 || status === 429
    this.code = details.code
    this.description = details.description
  }
}

/**
 * Whether a provider error says only that the id does not exist: a 404, or
 * the 400 `BAD_REQUEST_ERROR` Razorpay (and the fake) answer for an unknown
 * id. A 401, a 403 or an unexpected answer is not: it means the call itself
 * failed, and must not read as "unknown".
 * @param error - What the call threw.
 * @returns True for an unknown-id answer.
 */
export function isUnknownIdError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false
  return error.status === 404 || (error.status === 400 && error.code === 'BAD_REQUEST_ERROR')
}
