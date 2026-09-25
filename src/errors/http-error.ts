// src/errors/http-error.ts
//
// Moved verbatim from middlewares/error.middleware.ts — see
// 2026-09-25-stream-4a-structure-design.md §2: error classes live outside
// every layer so any layer can throw one without a banned import.

/**
 * An error carrying the HTTP status the client should receive.
 */
export class HttpError extends Error {
  /**
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param code - Optional stable, machine-readable token a client can branch on (e.g. `ACCESS_TOKEN_EXPIRED`), independent of `message` or `errors`.
   * @param errors - Optional field-level detail, e.g. from a validator.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly code?: string,
    public readonly errors?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
