// src/middlewares/error.middleware.ts
//
// The envelope is core's: { success, message, statusCode, errors }. RFC 9457
// problem+json is the modern standard and is the better choice for a new
// API — but switching it here would mean rewriting every ported controller
// and the frontend's interceptors, which defeats derive-and-strip. It ships
// as a recipe instead. See spec §13.
import { STATUS_CODES } from 'node:http'
import { type NextFunction, type Request, type Response } from 'express'
import { REQUEST_ID_HEADER } from '@/middlewares/request-id.middleware'
import { errorResponse } from '@/utilities/response.utilities'

/**
 * An error carrying the HTTP status the client should receive.
 */
export class HttpError extends Error {
  /**
   * @param message - Message safe to return to the client.
   * @param statusCode - HTTP status. Defaults to 500.
   * @param errors - Optional field-level detail, e.g. from a validator.
   */
  constructor(
    message: string,
    public readonly statusCode = 500,
    public readonly errors?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// Express's own body parser does not throw HttpError. `express.json()` and
// `express.urlencoded()` raise `http-errors` instances, which carry the
// intended status on BOTH `.status` and `.statusCode`, plus `expose: true`
// when the message is safe to return. Honouring only HttpError turned every
// one of those into a 500: malformed JSON answered 500 instead of 400, and a
// body over the 1mb limit answered 500 instead of 413. Worse, both then took
// the `>= 500` branch below, so every typo'd client request wrote a
// server-severity console.error — diluting exactly the signal that branch
// exists to preserve.
const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 499

/**
 * The client-error status an arbitrary error asks for, if any.
 *
 * Deliberately narrow: only an integer in 400-499 is honoured. A 5xx from a
 * foreign error is NOT trusted — it would skip the masking below and could
 * leak an internal message — and anything else falls through to 500.
 * @param error - The thrown or forwarded error.
 * @returns The status in 400-499, or undefined.
 */
function clientStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const claimed = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode
  if (typeof claimed !== 'number' || !Number.isSafeInteger(claimed)) return undefined
  return claimed >= CLIENT_ERROR_MIN && claimed <= CLIENT_ERROR_MAX ? claimed : undefined
}

/**
 * The message a 4xx from a foreign error may show the client.
 *
 * `expose === true` is http-errors' own explicit marker for "this message was
 * written for the client". Anything else — a library error that merely
 * happens to carry a `status`, an internal error someone tagged — gets the
 * generic reason phrase instead, so an internal message can never leak
 * through this path.
 * @param error - The thrown or forwarded error.
 * @param statusCode - The already-resolved 4xx status.
 * @returns A message safe to return to the client.
 */
function clientMessageOf(error: unknown, statusCode: number): string {
  const candidate = error as { expose?: unknown; message?: unknown }
  const isExposed = candidate.expose === true && typeof candidate.message === 'string'
  return isExposed ? (candidate.message as string) : (STATUS_CODES[statusCode] ?? 'Error')
}

/**
 * Terminal error handler. Must be registered last and must take four
 * parameters — Express identifies error handlers by arity, so dropping the
 * unused `next` silently turns this into ordinary middleware.
 * @param error - The thrown or forwarded error.
 * @param request - The request.
 * @param response - The response.
 * @param _next - Required for Express to recognise the arity.
 */
export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction
): void {
  const httpError = error instanceof HttpError ? error : undefined
  const statusCode = httpError?.statusCode ?? clientStatusOf(error) ?? 500

  // A 500 means we got it wrong, so the real message stays server-side — but
  // "server-side" must mean somewhere, not nowhere. Masking the message from
  // the client without logging the original anywhere leaves an operator with
  // nothing to search and a user's bug report with nothing to point at.
  if (statusCode >= 500) {
    console.error(`[${String(response.getHeader(REQUEST_ID_HEADER))}]`, error)
  }

  errorResponse(response, messageFor(error, httpError, statusCode), statusCode, httpError?.errors)
}

/**
 * Resolve the client-facing message for a resolved status.
 *
 * HttpError's message is always exposed — that is the class's contract, it
 * is constructed with a message chosen for the client. Everything else is
 * masked at 5xx and vetted at 4xx.
 * @param error - The thrown or forwarded error.
 * @param httpError - The same error when it is an HttpError.
 * @param statusCode - The already-resolved status.
 * @returns A message safe to return to the client.
 */
function messageFor(error: unknown, httpError: HttpError | undefined, statusCode: number): string {
  if (statusCode >= 500) return 'Internal server error'
  if (httpError) return httpError.message
  return clientMessageOf(error, statusCode)
}
