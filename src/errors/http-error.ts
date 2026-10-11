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
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param code - Optional stable, machine-readable token a client can branch on (e.g. `ACCESS_TOKEN_EXPIRED`), independent of `message` or `errors`.
   * @param errors - Optional field-level detail, e.g. from a validator.
   * @param options - Optional settings forwarded to `Error`.
   * @param options.cause - The underlying fault a 5xx wraps. `errorHandler` reports a 5xx `HttpError` to error tracking only when it has one.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code?: string,
    public readonly errors?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'HttpError'
  }
}
