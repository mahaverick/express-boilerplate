/**
 * @file The HTTP error class: an error that carries the status the client
 * receives and a message `errorHandler` shows on a 4xx.
 */

/**
 * An error carrying the HTTP status the client should receive. Its message is
 * shown to the client on a 4xx; `errorHandler` masks a 5xx's, except a
 * `MaintenanceModeError`'s, which is the owner's own text.
 */
export class HttpError extends Error {
  /**
   * How long the client should wait before retrying, in seconds:
   * `errorHandler` sends it as `Retry-After` on any `HttpError` that carries
   * one.
   */
  readonly retryAfterSeconds?: number

  /**
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param code - Optional stable, machine-readable token a client can branch on (e.g. `ACCESS_TOKEN_EXPIRED`), independent of `message` or `errors`.
   * @param errors - Optional field-level detail, e.g. from a validator.
   * @param options - Optional settings: a cause, forwarded to `Error`, and a retry wait.
   * @param options.cause - The underlying fault a 5xx wraps. `errorHandler` reports a 5xx `HttpError` to error tracking only when it has one.
   * @param options.retryAfterSeconds - The `Retry-After` value to answer with, in seconds.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code?: string,
    public readonly errors?: unknown,
    options?: { cause?: unknown; retryAfterSeconds?: number }
  ) {
    super(message, options !== undefined && 'cause' in options ? { cause: options.cause } : {})
    this.name = 'HttpError'
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds
  }
}
