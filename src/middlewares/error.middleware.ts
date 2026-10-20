/**
 * @file The terminal error handler. It writes the envelope
 * `{ success, message, statusCode, code?, errors?, errorId?, requestId }`,
 * plus `mode` and `since` on a maintenance-mode 503 (see ARCHITECTURE.md for
 * why not RFC 9457). `errors` is field-level validation detail; `code` is one
 * stable token a client branches on, kept separate so the two never collide.
 * Every 5xx response except a maintenance refusal carries an `errorId`; a
 * 5xx the capture rule (`shouldCaptureHttpError`) admits is also reported to
 * error tracking under that id and recorded, scrubbed, on the active span.
 */
import { STATUS_CODES } from 'node:http'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { uuidv7 } from '@posthog/core/vendor/uuidv7'
import { type NextFunction, type Request, type Response } from 'express'
import { REQUEST_ID_HEADER } from '@/constants/global.constants'
import { HttpError } from '@/errors/http-error'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import {
  isUnstorableTextError,
  isUntranslatableCharacterError,
  redactedForLog,
} from '@/errors/postgres-errors'
import { PosthogUnavailableError } from '@/errors/posthog-errors'
import { routeTemplateOf } from '@/middlewares/route-template.middleware'
import {
  reportErrorWithSpan,
  shouldCaptureHttpError,
} from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'
import { errorResponse } from '@/utilities/response.utilities'

const CLIENT_ERROR_MIN = 400
const CLIENT_ERROR_MAX = 499
const BAD_REQUEST = 400

/**
 * The status error tracking records for a failure after the headers were
 * sent, whose real status is unknown.
 */
const HEADERS_SENT_STATUS = 500

/**
 * The error codes a socket closed by the client produces.
 */
const CLIENT_ABORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE',
])

/**
 * The client-error status an arbitrary error asks for, if any. Express's body
 * parsers raise `http-errors` instances (malformed JSON is 400, an oversized
 * body 413) with the status on `.status` and `.statusCode`; honouring it
 * keeps a client mistake out of the 5xx log.
 *
 * Deliberately narrow: only an integer in 400-499 is honoured. A 5xx or any
 * other status from a foreign error is not trusted and yields undefined.
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
 * Bytes in a kilobyte and a megabyte, for the oversize-body message.
 */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = 1024 * 1024

/**
 * A body-parser limit as a person reads it.
 * @param bytes - The limit in bytes.
 * @returns For example "1 MB" or "100 KB".
 */
function formatByteLimit(bytes: number): string {
  if (bytes >= BYTES_PER_MB && bytes % BYTES_PER_MB === 0)
    return `${String(bytes / BYTES_PER_MB)} MB`
  return `${String(Math.round(bytes / BYTES_PER_KB))} KB`
}

/**
 * The answer a body-parser refusal gets: its own copy and a stable code, so
 * a client never reads the parser's raw text ("Unexpected end of JSON input",
 * "request entity too large").
 * @param error - The thrown or forwarded error.
 * @returns The message and code, or undefined for any other error.
 */
function bodyParserAnswerOf(error: unknown): { message: string; code: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { type, limit } = error as { type?: unknown; limit?: unknown }
  if (type === 'entity.parse.failed') {
    return {
      code: 'malformed_json',
      message: "We couldn't read the request body as JSON. Fix its syntax, then send it again.",
    }
  }
  if (type === 'entity.too.large' && typeof limit === 'number') {
    return {
      code: 'payload_too_large',
      message: `The request body is over the ${formatByteLimit(limit)} limit. Send a smaller body.`,
    }
  }
  return undefined
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
 * Whether a failure is the client having gone away: a connection-reset or
 * aborted error on a request whose socket is already destroyed. Not a fault
 * of this server, so never reported.
 * @param error - The thrown or forwarded error.
 * @param request - The request.
 * @returns True for a client abort.
 */
function isClientAbort(error: unknown, request: Request): boolean {
  const isSocketGone = (request as Partial<Request>).socket?.destroyed === true
  if (!isSocketGone || typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return (typeof code === 'string' && CLIENT_ABORT_CODES.has(code)) || message === 'aborted'
}

/**
 * The request id the requestId middleware set on the response.
 * @param response - The response.
 * @returns The id, or an empty string when there is none.
 */
function requestIdOf(response: Response): string {
  const id = response.getHeader(REQUEST_ID_HEADER)
  return typeof id === 'string' ? id : ''
}

/**
 * Report a server error to error tracking and record it, scrubbed, on the
 * active span, which is marked as an error. The span takes the exception
 * list the report built, so the error is built once.
 * @param error - The thrown or forwarded error.
 * @param request - The request.
 * @param response - The response.
 * @param status - The status written, or `HEADERS_SENT_STATUS`.
 * @returns The error id.
 */
function captureHttpError(
  error: unknown,
  request: Request,
  response: Response,
  status: number
): string {
  const { errorId, spanError } = reportErrorWithSpan(error, {
    capturePoint: 'http',
    handled: true,
    http: {
      method: (request as Partial<Request>).method ?? 'UNKNOWN',
      route: routeTemplateOf(request),
      status,
      requestId: requestIdOf(response),
    },
  })
  const span = trace.getActiveSpan()
  if (span !== undefined) {
    span.recordException(spanError())
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
  return errorId
}

/**
 * Terminal error handler. Must be registered last and must take four
 * parameters — Express identifies error handlers by arity, so dropping the
 * unused `next` silently turns this into ordinary middleware.
 * Every error response it writes is `Cache-Control: no-store`, whichever
 * middleware refused the request.
 * Once headers are sent (a failure mid-stream), no second response can be
 * written: the error is reported (as a 500, unless the client went away),
 * logged redacted with its `errorId`, and the socket destroyed. It is not
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
    const errorId = isClientAbort(error, request)
      ? uuidv7()
      : captureHttpError(error, request, response, HEADERS_SENT_STATUS)
    logger.error('Error after response headers were sent', {
      error: redactedForLog(error),
      errorId,
    })
    request.socket.destroy()
    return
  }

  // An error body is never worth caching, and one header for every refusal keeps a gated route's answer the same as an unknown path's.
  response.set('Cache-Control', 'no-store')

  // A maintenance refusal is not a fault: its message is the owner's, shown as is, and it is never logged.
  if (error instanceof MaintenanceModeError) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds))
    errorResponse(response, error.message, error.statusCode, error.code, undefined, {
      mode: error.mode,
      since: error.since,
    })
    return
  }

  const httpError = error instanceof HttpError ? error : undefined
  if (httpError?.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(httpError.retryAfterSeconds))
  }
  // A character Postgres cannot store came from the client: a 400, masked and unlogged like any 4xx (except a value-free warn for 22P05, below).
  const statusCode =
    httpError?.statusCode ??
    clientStatusOf(error) ??
    (isUnstorableTextError(error) ? BAD_REQUEST : 500)

  if (statusCode < 500) {
    // A 22P05 can be a database encoding fault rather than client input: leave one value-free trace.
    if (httpError === undefined && isUntranslatableCharacterError(error)) {
      logger.warn('Postgres refused a character in client text', {
        route: routeTemplateOf(request),
      })
    }
    const answer = clientAnswerOf(error, httpError, statusCode)
    errorResponse(response, answer.message, statusCode, answer.code, httpError?.errors)
    return
  }

  const isCaptured = shouldCaptureHttpError(error, statusCode) && !isClientAbort(error, request)
  const errorId = isCaptured ? captureHttpError(error, request, response, statusCode) : uuidv7()
  // Masked, so logged here (redacted: a failed write carries its values); a PostHog 502's thrower logged it.
  if (!(error instanceof PosthogUnavailableError)) {
    logger.error('Unhandled server error', { error: redactedForLog(error), errorId })
  }
  errorResponse(
    response,
    messageFor(error, httpError, statusCode),
    statusCode,
    httpError?.code,
    httpError?.errors,
    { errorId }
  )
}

/**
 * The message and code a 4xx answers: a body-parser refusal's own copy and
 * code, or else `messageFor`'s message and the `HttpError`'s code.
 * @param error - The thrown or forwarded error.
 * @param httpError - The same error when it is an HttpError.
 * @param statusCode - The already-resolved 4xx status.
 * @returns The message, and the code if any.
 */
function clientAnswerOf(
  error: unknown,
  httpError: HttpError | undefined,
  statusCode: number
): { message: string; code: string | undefined } {
  const parserAnswer = httpError === undefined ? bodyParserAnswerOf(error) : undefined
  return (
    parserAnswer ?? { message: messageFor(error, httpError, statusCode), code: httpError?.code }
  )
}

/**
 * Resolve the client-facing message for a resolved status.
 *
 * Every status of 500 or above is masked, whatever the error; a maintenance
 * refusal never gets here (`errorHandler` answers it first). Below 500, an
 * `HttpError`'s message is shown, since it is written for the client; any
 * other error's is vetted by `clientMessageOf`.
 * @param error - The thrown or forwarded error.
 * @param httpError - The same error when it is an HttpError.
 * @param statusCode - The already-resolved status.
 * @returns A message safe to return to the client.
 */
function messageFor(error: unknown, httpError: HttpError | undefined, statusCode: number): string {
  if (statusCode >= 500)
    return 'Our server hit an error. Try again, and contact support with the error ID if it happens again.'
  if (httpError) return httpError.message
  return clientMessageOf(error, statusCode)
}
