/**
 * @file The HTTP error class: an error that carries the status the client
 * receives and a message `errorHandler` shows on a 4xx, or on a 5xx that
 * opts in with `exposeMessage`.
 */

/**
 * An error carrying the HTTP status the client should receive. Its message is
 * shown to the client on a 4xx; `errorHandler` masks a 5xx's, except a
 * `MaintenanceModeError`'s, which is the owner's own text, and one built with
 * `exposeMessage: true`.
 */
export class HttpError extends Error {
  /**
   * How long the client should wait before retrying, in seconds:
   * `errorHandler` sends it as `Retry-After` on any `HttpError` that carries
   * one.
   */
  readonly retryAfterSeconds?: number

  /**
   * Structured facts about a refusal that a client can show, such as a
   * limit and how much of it is used. `errorHandler` writes them as
   * `details` on a 4xx and never on a 5xx.
   */
  readonly details?: Record<string, unknown>

  /**
   * True when a 5xx's message is guidance written for the client, so
   * `errorHandler` shows it instead of the masked message. Set it only on
   * literal text written here, never on text taken from a cause.
   */
  readonly exposeMessage?: true

  /**
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param code - Optional stable, machine-readable token a client can branch on (e.g. `ACCESS_TOKEN_EXPIRED`), independent of `message` or `errors`.
   * @param errors - Optional field-level detail, e.g. from a validator.
   * @param options - Optional settings: a cause, forwarded to `Error`, a retry wait, details and whether a 5xx shows its message.
   * @param options.cause - The underlying fault a 5xx wraps. `errorHandler` reports a 5xx `HttpError` to error tracking only when it has one.
   * @param options.retryAfterSeconds - The `Retry-After` value to answer with, in seconds.
   * @param options.details - Structured facts for the client, sent as `details` next to `code`.
   * @param options.exposeMessage - True to show a 5xx's message to the client instead of masking it; for written guidance only.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code?: string,
    public readonly errors?: unknown,
    options?: {
      cause?: unknown
      retryAfterSeconds?: number
      details?: Record<string, unknown>
      exposeMessage?: boolean
    }
  ) {
    super(message, options !== undefined && 'cause' in options ? { cause: options.cause } : {})
    this.name = 'HttpError'
    if (options?.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds
    if (options?.details !== undefined) this.details = options.details
    if (options?.exposeMessage === true) this.exposeMessage = true
  }
}
