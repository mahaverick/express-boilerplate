/**
 * @file Postgres query-error handling: one unique-violation check for every
 * repository, optionally scoped to one constraint name, and the redaction
 * every failed query goes through before it is logged.
 */
import { DrizzleQueryError } from 'drizzle-orm'
import postgres from 'postgres'

/**
 * Postgres's SQLSTATE for a unique-constraint violation.
 */
const UNIQUE_VIOLATION_CODE = '23505'

/**
 * Whether an error (or its Drizzle-wrapped cause) is a Postgres unique
 * violation (23505), optionally scoped to one named constraint.
 * @param error - The error thrown by a write.
 * @param constraintName - When given, only a violation of this exact constraint counts; omit to match any unique violation.
 * @returns True when error is (or wraps) a 23505 unique violation, and — when constraintName is given — the violated constraint matches it.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  if (!(cause instanceof postgres.PostgresError) || cause.code !== UNIQUE_VIOLATION_CODE) {
    return false
  }
  return constraintName === undefined || cause.constraint_name === constraintName
}

/**
 * SQLSTATEs Postgres raises when a bound text value holds a character it
 * cannot store: 22021 (`character_not_in_repertoire`, a NUL in `text`) and
 * 22P05 (`untranslatable_character`, a NUL in `jsonb`).
 */
const UNSTORABLE_TEXT_CODES: ReadonlySet<string> = new Set(['22021', '22P05'])

/**
 * Whether an error (or its Drizzle-wrapped cause) is Postgres refusing a
 * character in caller-supplied text: the client's input, not a server
 * fault. Request validation refuses these first; this is the backstop for
 * a field it missed.
 * @param error - The thrown or forwarded error.
 * @returns True when error is (or wraps) a 22021 or 22P05 driver error.
 */
export function isUnstorableTextError(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  return cause instanceof postgres.PostgresError && UNSTORABLE_TEXT_CODES.has(cause.code)
}

/**
 * The shape of a failed database query as the ORM reports it: the SQL text
 * and the bound parameter values. Matched structurally, not with
 * `instanceof DrizzleQueryError`, so any error carrying a query and its
 * parameters is redacted; a false match only costs a redacted log line.
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
export function isQueryError(error: unknown): error is QueryErrorShape {
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
 * The stack of a query error with its message removed: call frames only.
 *
 * `error.stack` embeds the message, which carries the bound parameters, so
 * the whole stack would leak what `redactedForLog` removes. A frame must be
 * indented (`/^\s+at /`, as V8 writes every frame), because the multi-line
 * message can contain an unindented line that starts with `at `.
 * @param error - The query error.
 * @returns The `at ...` frames, or undefined when there is no usable stack.
 */
function stackFramesOf(error: QueryErrorShape): string | undefined {
  const { stack } = error as { stack?: unknown }
  if (typeof stack !== 'string') return undefined
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n')
  return frames === '' ? undefined : frames
}

/**
 * What a failed database query may be logged as.
 *
 * A query error's `message` embeds the bound parameter values (for a failed
 * user insert, the email address and password hash), and so does its stack.
 * The record keeps the parameterised SQL text, the driver's SQLSTATE code,
 * the parameter count and the call frames: enough to diagnose a 500 with
 * no values. The message is dropped, not truncated, and the driver error's
 * message and `detail` are dropped too, since Postgres embeds offending
 * values in them.
 *
 * `serializeOneError` (logger.service.ts) applies this to every
 * Error-valued log field and its `.cause` chain. A query-shaped value that
 * is not an `Error`, such as an unhandled rejection's `reason` in index.ts,
 * needs an explicit call at the logging site. Controllers, middlewares,
 * services and workers also call it directly; that is harmless, because a
 * redacted record has no `params`, so a second call returns it unchanged.
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
