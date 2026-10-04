/**
 * @file The terminal error handler. It writes the envelope
 * `{ success, message, statusCode, code?, errors? }` (see ARCHITECTURE.md for
 * why not RFC 9457). `errors` is field-level validation detail; `code` is one
 * stable token a client branches on, kept separate so the two never collide.
 */
import { STATUS_CODES } from 'node:http'
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import { logger } from '@/services/logger.service'
import { errorResponse } from '@/utilities/response.utilities'

const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 499

/**
 * The client-error status an arbitrary error asks for, if any. Express's body
 * parsers raise `http-errors` instances (malformed JSON is 400, an oversized
 * body 413) with the status on `.status` and `.statusCode`; honouring it
 * keeps a client mistake out of the 5xx log.
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
 * Once headers are sent (a failure mid-stream), no second response can be
 * written: the error is logged redacted and the socket destroyed. It is not
 * passed to Express's final handler, which would print it unredacted.
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
  if (response.headersSent) {
    logger.error('Error after response headers were sent', { error: redactedForLog(error) })
    request.socket.destroy()
    return
  }

  const httpError = error instanceof HttpError ? error : undefined
  const statusCode = httpError?.statusCode ?? clientStatusOf(error) ?? 500

  // Masked, so logged here (redacted: a failed write carries its values); a timeline 502's thrower logged it.
  if (statusCode >= 500 && !(error instanceof TimelineUnavailableError)) {
    logger.error('Unhandled server error', { error: redactedForLog(error) })
  }

  errorResponse(
    response,
    messageFor(error, httpError, statusCode),
    statusCode,
    httpError?.code,
    httpError?.errors
  )
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
