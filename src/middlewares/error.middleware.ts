// src/middlewares/error.middleware.ts
//
// The envelope is core's: { success, message, statusCode, code?, errors? }.
// RFC 9457 problem+json is the modern standard and is the better choice for
// a new API — but switching it here would mean rewriting every ported
// controller and the frontend's interceptors, which defeats
// derive-and-strip. It ships as a recipe instead. See spec §13.
//
// `code` and `errors` are deliberately separate fields, not one overloaded
// one. `errors` is field-level validation detail (e.g. `{ email: ['is
// required'] }`) — shaped by whatever validator produced it, and absent
// most of the time. `code` is a single, stable, machine-readable token (e.g.
// `ACCESS_TOKEN_EXPIRED`) a client branches on to decide what to do next,
// independent of whatever `errors` may or may not also be carrying for the
// same response. Putting both in `errors` would mean a client parsing it for
// field errors gets something structurally different the one time `code` is
// also present, and the next caller who adds real field-level errors to a
// response that also sets `code` would collide with it.
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
 * The shape of a failed database query as the ORM reports it: the SQL text
 * and the bound parameter values. Matched structurally rather than with
 * `instanceof DrizzleQueryError`, so this module — the error contract —
 * does not take a runtime dependency on the ORM. The fallback is the safe
 * direction anyway: a foreign error that merely looks like this is logged
 * redacted, which costs nothing.
 */
interface QueryErrorShape {
  query: string
  params: unknown[]
  cause?: unknown
}

/**
 * Whether an error carries a SQL query and its bound parameters.
 * @param error - The thrown or forwarded error.
 * @returns True when the error exposes both `query` and `params`.
 */
function isQueryError(error: unknown): error is QueryErrorShape {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { query?: unknown; params?: unknown }
  return typeof candidate.query === 'string' && Array.isArray(candidate.params)
}

/**
 * The Postgres `SQLSTATE` code a driver error carries, if any — e.g.
 * `22001` (string too long for its column) or `23505` (unique violation).
 * @param cause - The driver error a query error wraps.
 * @returns The five-character code, or undefined when the cause carries none.
 */
function driverCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The stack of a query error with its message line removed — call frames
 * only.
 *
 * The message line is exactly what must not be logged (see
 * `redactedForLog`), and `error.stack` embeds it verbatim on the first
 * line, so logging the stack whole would leak the parameters straight back
 * through the channel the redaction closed. The frames themselves name the
 * repository and controller the query came from, which is the genuinely
 * useful half.
 * @param error - The query error.
 * @returns The `at ...` frames, or undefined when there is no usable stack.
 */
function stackFramesOf(error: QueryErrorShape): string | undefined {
  const { stack } = error as { stack?: unknown }
  if (typeof stack !== 'string') return undefined
  const frames = stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n')
  return frames === '' ? undefined : frames
}

/**
 * What a failed database query may be logged as.
 *
 * A query error's `message` is built as `` `Failed query: ${query}\nparams:
 * ${params}` `` — the BOUND PARAMETER VALUES are part of the string. For a
 * failed `insert into users`, those parameters are the registrant's email
 * address and their bcrypt hash, and `console.error(error)` prints the
 * message (via the stack) in full. Every write that fails for any reason
 * other than the unique violation `BaseRepository` already translates to a
 * 409 therefore used to put credentials into the log — the one place a
 * masked 500 is supposed to make an error safely recoverable, not the place
 * to write the data the masking exists to protect.
 *
 * What survives is the SQL TEXT (parameterised, so it names columns and
 * tables and contains no values), the driver's `SQLSTATE` code, and the
 * call frames. That is enough to identify the failing statement and look
 * the failure up in
 * https://www.postgresql.org/docs/current/errcodes-appendix.html — which is
 * what makes a 500 diagnosable. Truncating the message instead was
 * considered and rejected: a shorter leak is still a leak, and where the
 * truncation lands would depend on the length of the query text, so the same
 * bug would leak on one table and not another.
 *
 * The driver error's own message is deliberately NOT carried over either,
 * for the same reason at one remove: Postgres embeds offending values in
 * some of them (`invalid input syntax for type uuid: "..."`), and its
 * `detail` field does so routinely (`Key (lower(email))=(...) already
 * exists.`). The code says the same thing without the value.
 *
 * Exported (not module-private) so `mailer.service.ts`'s `recordDelivery`
 * can reuse it verbatim for a failed `EmailLogRepository.record()` write —
 * that failure is the identical shape (a `DrizzleQueryError` wrapping a
 * `postgres.PostgresError` in `.cause`, same as here), and its bound
 * parameters include a recipient email address, which is PII. Building a
 * second, parallel redaction for that one call site would be exactly the
 * duplicated-logic-block this codebase treats as a defect; this is the one
 * definition both places use.
 * @param error - The thrown or forwarded error.
 * @returns The error itself when it is not a query error; a redacted, parameter-free record when it is.
 */
export function redactedForLog(error: unknown): unknown {
  if (!isQueryError(error)) return error
  return {
    name: (error as { name?: unknown }).name ?? 'QueryError',
    query: error.query,
    driverCode: driverCodeOf(error.cause),
    paramCount: error.params.length,
    stack: stackFramesOf(error),
  }
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
  //
  // "Server-side" is not the same as "safe", though: a failed database write
  // carries the values it was writing. `redactedForLog` strips those and
  // keeps what actually makes a 500 diagnosable — see its own comment.
  if (statusCode >= 500) {
    console.error(`[${String(response.getHeader(REQUEST_ID_HEADER))}]`, redactedForLog(error))
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
