// src/errors/postgres-errors.ts
//
// Postgres query-error handling: one unique-violation check for every
// repository, optionally scoped to one constraint name, and the redaction
// every failed query goes through before it is logged.
import { DrizzleQueryError } from 'drizzle-orm'
import postgres from 'postgres'

// Postgres error code for a unique-constraint violation.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
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
 * The shape of a failed database query as the ORM reports it: the SQL text
 * and the bound parameter values. Matched structurally rather than with
 * `instanceof DrizzleQueryError`, so any error carrying a query and its
 * parameters is redacted, not only the ORM's own class. That is the safe
 * direction: a foreign error that merely looks like this is logged
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
 * The stack of a query error with its message line removed — call frames
 * only.
 *
 * The message line is exactly what must not be logged (see
 * `redactedForLog`), and `error.stack` embeds it verbatim on the first
 * line, so logging the stack whole would leak the parameters straight back
 * through the channel the redaction closed. The frames themselves name the
 * call site the query came from, which is the genuinely useful half.
 *
 * Matches `/^\s+at /` — a real frame, NOT `line.trimStart().startsWith('at
 * ')`. V8 always indents a genuine call frame with at least four spaces;
 * requiring leading whitespace before `at ` is what makes an UNINDENTED
 * line that merely happens to begin with those two characters fail to
 * match, which matters because the message this strips can itself be
 * multi-line (a query error's message embeds the SQL text).
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
 * A query error's `message` is built as `` `Failed query: ${query}\nparams:
 * ${params}` `` — the BOUND PARAMETER VALUES are part of the string. For a
 * failed `insert into users`, those parameters are the registrant's email
 * address and their bcrypt hash, and `console.error(error)` prints the
 * message (via the stack) in full. Logged raw, every write that fails for
 * any reason other than the unique violation `BaseRepository` translates to
 * a 409 would put credentials into the log — the one place a masked 500 is
 * supposed to make an error safely recoverable, not the place to write the
 * data the masking exists to protect.
 *
 * What survives is the SQL TEXT (parameterised, so it names columns and
 * tables and contains no values), the driver's `SQLSTATE` code, and the
 * call frames. That is enough to identify the failing statement and look
 * the failure up in
 * https://www.postgresql.org/docs/current/errcodes-appendix.html — which is
 * what makes a 500 diagnosable. The message is dropped, not truncated: a
 * shorter leak is still a leak, and where a truncation lands depends on the
 * length of the query text, so the same bug would leak on one table and not
 * another.
 *
 * The driver error's own message is deliberately NOT carried over either,
 * for the same reason at one remove: Postgres embeds offending values in
 * some of them (`invalid input syntax for type uuid: "..."`), and its
 * `detail` field does so routinely (`Key (lower(email))=(...) already
 * exists.`). The code says the same thing without the value.
 *
 * `logger.service.ts`'s `serializeOneError` applies this automatically to
 * every Error-valued field the logger is given, and to each error in its
 * `.cause` chain. It only reaches values that are `instanceof Error`,
 * though — a query-shaped value that isn't one, such as `index.ts`'s
 * unhandled-rejection `reason` (a rejection can settle with anything, not
 * only an Error), still needs its own explicit `redactedForLog(error)` call
 * at the logging site. Calling it twice on the same value is safe either
 * way: a redacted object has `paramCount`, not `params`, so `isQueryError`
 * on it is false and a second call returns it unchanged.
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
