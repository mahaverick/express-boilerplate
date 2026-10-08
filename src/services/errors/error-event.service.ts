/**
 * @file How a server error becomes a PostHog `$exception` event: the
 * exception list `@posthog/core`'s `ErrorPropertiesBuilder` builds with the
 * node stack parser, scrubbed by `scrubText`, its fingerprint for the
 * throttle, and the signed batch event with the release, the request or job,
 * the trace and the acting user and tenant. It reads only an error's name,
 * message, stack frames and `cause`, and a thrown non-Error object's class
 * name, never its keys: a Postgres error's `detail`, `query`,
 * `parameters` and `where`, an `HttpError`'s `errors`, and a failed query's
 * bound parameters are never read.
 */
import {
  createStackParser,
  ErrorCoercer,
  ErrorPropertiesBuilder,
  nodeStackLineParser,
  ObjectCoercer,
  PrimitiveCoercer,
  StringCoercer,
  type Exception,
  type StackFrame,
} from '@posthog/core/error-tracking'
import { getEnv } from '@/configs/env.config'
import { ERROR_CAUSE_DEPTH, ERROR_FRAME_LIMIT } from '@/constants/error-tracking.constants'
import { isQueryError } from '@/errors/postgres-errors'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import {
  toPosthogBatchEvent,
  type PosthogBatchEvent,
} from '@/services/analytics/posthog-batch.service'
import { scrubText } from '@/services/errors/error-scrubber.service'
import { requestContextStore } from '@/services/request-context.service'

/**
 * Where an error was caught: the 5xx handler, a process fault, or a job's
 * final failed attempt.
 */
export type ErrorCapturePoint = 'http' | 'process' | 'job'

/**
 * What the caller knows about an error besides the error itself.
 */
export interface ErrorContext {
  capturePoint: ErrorCapturePoint
  /**
   * False for a process fault, which nothing caught; true otherwise.
   */
  handled: boolean
  /**
   * The request, for `http`. `route` is the route template, or `unmatched`;
   * never the raw URL.
   */
  http?: { method: string; route: string; status: number; requestId: string }
  /**
   * The job, for `job`.
   */
  job?: { queue: string; name: string; attemptsMade: number }
}

/**
 * One built event, its scrubbed exception list and the key the throttle
 * counts it under.
 */
export interface BuiltErrorEvent {
  event: PosthogBatchEvent
  exceptions: Exception[]
  fingerprint: string
}

/**
 * A stand-in for an error that `span.recordException` can take: the
 * scrubbed type as `name`, the scrubbed value as `message`, and, when there
 * are frames, a stack of the scrubbed frames, innermost first.
 */
export interface SpanError {
  name: string
  message: string
  stack?: string
}

/**
 * The exception list builder: `Error`s first, then any other object,
 * strings and other primitives, with V8 stack lines parsed by the node parser.
 */
const builder = new ErrorPropertiesBuilder(
  [new ErrorCoercer(), new ObjectCoercer(), new StringCoercer(), new PrimitiveCoercer()],
  createStackParser('node:javascript', nodeStackLineParser)
)

/**
 * A V8 stack frame line: indented, then `at `. Any other line of a stack is
 * the message, which can carry what the scrubber does not know to remove.
 */
const FRAME_LINE = /^\s+at /

/**
 * The value an event carries for a thrown value whose message, or whose
 * every property, throws when read.
 */
const UNREADABLE_VALUE = '[unreadable error]'

/**
 * Read one part of a thrown value, which may be a getter or a Proxy trap
 * that throws.
 * @param read - Reads the part.
 * @param fallback - What to use when reading throws.
 * @returns The part, or the fallback.
 */
function readSafely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * Whether a value is an `Error`, including one from another realm. A value
 * that throws when asked is not.
 * @param value - Anything thrown.
 * @returns True for an `Error` instance or an object tagged `[object Error]`.
 */
function isErrorValue(value: unknown): value is Error {
  return readSafely(
    () => value instanceof Error || Object.prototype.toString.call(value) === '[object Error]',
    false
  )
}

/**
 * The stack frame lines of an error, without the message lines a stack
 * starts with.
 * @param error - The error.
 * @returns The `at …` lines, possibly none.
 */
function frameLinesOf(error: Error): string[] {
  const stack = readSafely<unknown>(() => error.stack, undefined)
  if (typeof stack !== 'string') return []
  return stack.split('\n').filter((line) => FRAME_LINE.test(line))
}

/**
 * The name of a value's class, read from its prototype and never from the
 * value itself (a parsed body can carry its own `constructor` key). Undefined
 * when it has none or reading it throws.
 * @param value - An object.
 * @returns The name.
 */
function constructorNameOf(value: object): string | undefined {
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (typeof prototype !== 'object' || prototype === null) return undefined
    const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
    const name: unknown = typeof constructor === 'function' ? constructor.name : undefined
    return typeof name === 'string' && name !== '' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * An error's name: its own `name`, else its constructor's, else `Error`.
 * @param error - The error.
 * @returns The name.
 */
function nameOf(error: Error): string {
  const name = readSafely<unknown>(() => error.name, undefined)
  if (typeof name === 'string' && name !== '') return name
  return constructorNameOf(error) ?? 'Error'
}

/**
 * An error's message as an event may carry it. A failed query's message
 * embeds its bound parameters, and its SQL text can carry inlined literals,
 * so neither is kept: the message is `Failed query`. A message that throws
 * when read is `[unreadable error]`.
 * @param error - The error.
 * @returns The message.
 */
function messageOf(error: Error): string {
  if (readSafely(() => isQueryError(error), false)) return 'Failed query'
  const message = readSafely<unknown>(() => error.message, UNREADABLE_VALUE)
  return typeof message === 'string' ? message : ''
}

/**
 * The first own property of a plain object that holds an `Error`, which
 * the builder would otherwise coerce in the object's place.
 * @param value - A non-`Error` object.
 * @returns The `Error`, or undefined.
 */
function nestedErrorOf(value: object): Error | undefined {
  const values = readSafely<unknown[]>(() => Object.values(value), [])
  for (const nested of values) {
    if (isErrorValue(nested)) return nested
  }
  return undefined
}

/**
 * An error rebuilt from the parts an event may carry, which is all the
 * builder then sees.
 */
class ReadableError extends Error {
  /**
   * @param name - The original error's name.
   * @param message - Its message, as `messageOf` keeps it.
   * @param frames - Its frame lines.
   * @param cause - Its `cause`, already made readable; undefined for none.
   */
  constructor(name: string, message: string, frames: string[], cause: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = name
    this.stack = frames.join('\n')
  }
}

/**
 * The `Error` a thrown value stands for: the value itself, or the first
 * `Error` a plain object holds.
 * @param value - Anything thrown.
 * @returns The error, or undefined when there is none.
 */
function errorIn(value: unknown): Error | undefined {
  if (isErrorValue(value)) return value
  if (typeof value === 'object' && value !== null) return nestedErrorOf(value)
  return undefined
}

/**
 * The value an event carries for a thrown object that is not an `Error`.
 */
const NON_ERROR_OBJECT_VALUE = 'Non-Error object thrown'

/**
 * Class names that say nothing about a thrown value: a plain object's and a
 * function's. Such a value is named `Error`.
 */
const NON_ERROR_CLASS_NAMES: ReadonlySet<string> = new Set(['Object', 'Function'])

/**
 * A copy of a thrown value that holds no `Error`. An object becomes an
 * error named for its class (`Error` for a plain object or a function) with a fixed
 * value, because its keys can be user input (a parsed body, a map keyed by
 * address) and are never read. An object that throws when asked anything
 * (a hostile Proxy) becomes `[unreadable error]`. A primitive is returned
 * as it is.
 * @param value - Anything thrown that `errorIn` found no `Error` in.
 * @returns The value to build from.
 */
function readableNonError(value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  const hasConstructor = readSafely<boolean | undefined>(() => 'constructor' in value, undefined)
  if (hasConstructor === undefined)
    return new ReadableError('Error', UNREADABLE_VALUE, [], undefined)
  const name = constructorNameOf(value)
  return new ReadableError(
    name === undefined || NON_ERROR_CLASS_NAMES.has(name) ? 'Error' : name,
    NON_ERROR_OBJECT_VALUE,
    [],
    undefined
  )
}

/**
 * A copy of a thrown value the builder can read safely. An `Error` (or an
 * object holding one) becomes a fresh `Error` carrying only its name, its
 * message (`messageOf`), its frame lines and, up to `ERROR_CAUSE_DEPTH`
 * links, its `cause` copied the same way. Each part is read through
 * `readSafely`, so a getter that throws costs that part, not the event.
 * Anything else is copied by `readableNonError`.
 * @param value - Anything thrown.
 * @param depth - How many links precede this one.
 * @returns The value to build from.
 */
function readable(value: unknown, depth: number): unknown {
  const error = errorIn(value)
  if (error === undefined) return readableNonError(value)
  const cause = readSafely<unknown>(() => error.cause, undefined)
  const hasCause = cause !== undefined && cause !== null && depth + 1 < ERROR_CAUSE_DEPTH
  return new ReadableError(
    nameOf(error),
    messageOf(error),
    frameLinesOf(error),
    hasCause ? readable(cause, depth + 1) : undefined
  )
}

/**
 * Whether a frame is the app's own code. The parser already marks native,
 * relative and `node_modules` frames as not; a `node:` frame and any path
 * through `node_modules` are not either.
 * @param frame - A parsed frame.
 * @returns True for an app frame.
 */
function isInAppFrame(frame: StackFrame): boolean {
  const filename = frame.filename ?? ''
  return (
    frame.in_app === true && !filename.startsWith('node:') && !filename.includes('node_modules')
  )
}

/**
 * A frame as it is sent: scrubbed filename and function, `in_app` decided by
 * `isInAppFrame`, and no other text.
 * @param frame - A parsed frame.
 * @returns The frame to send.
 */
function sentFrame(frame: StackFrame): StackFrame {
  return {
    platform: frame.platform,
    ...(frame.filename !== undefined && { filename: scrubText(frame.filename) }),
    ...(frame.function !== undefined && { function: scrubText(frame.function) }),
    ...(frame.lineno !== undefined && { lineno: frame.lineno }),
    ...(frame.colno !== undefined && { colno: frame.colno }),
    in_app: isInAppFrame(frame),
  }
}

/**
 * An exception as it is sent: scrubbed type and value, and at most
 * `ERROR_FRAME_LIMIT` frames, the innermost ones (the parser lists frames
 * outermost first).
 * @param exception - One built exception.
 * @returns The exception to send.
 */
function sentException(exception: Exception): Exception {
  const frames = exception.stacktrace?.frames ?? []
  return {
    type: scrubText(exception.type ?? 'Error'),
    value: scrubText(exception.value ?? ''),
    ...(exception.mechanism !== undefined && { mechanism: exception.mechanism }),
    ...(frames.length > 0 && {
      stacktrace: {
        type: 'raw' as const,
        frames: frames.slice(-ERROR_FRAME_LIMIT).map((frame) => sentFrame(frame)),
      },
    }),
  }
}

/**
 * The scrubbed exception list of a thrown value: the value and its `cause`
 * chain, at most `ERROR_CAUSE_DEPTH` exceptions.
 * @param error - Anything thrown.
 * @param isHandled - Whether something caught it; recorded in each exception's mechanism.
 * @returns The exceptions, the thrown value first.
 */
export function exceptionListOf(error: unknown, isHandled = true): Exception[] {
  const built = builder.buildFromUnknown(readable(error, 0), {
    mechanism: { handled: isHandled, type: 'generic' },
  })
  return built.$exception_list
    .slice(0, ERROR_CAUSE_DEPTH)
    .map((exception) => sentException(exception))
}

/**
 * The throttle's key for an exception list: the first exception's type and
 * its innermost app frame (`filename:function:lineno`), the frame that threw;
 * with no app frame, its type and scrubbed value.
 * @param exceptions - A scrubbed exception list.
 * @returns The fingerprint.
 */
export function fingerprintOf(exceptions: Exception[]): string {
  const [first] = exceptions
  if (first === undefined) return 'Error'
  const type = first.type ?? 'Error'
  const frame = (first.stacktrace?.frames ?? []).findLast((candidate) => candidate.in_app === true)
  if (frame === undefined) return `${type}\n${first.value ?? ''}`
  return `${type}\n${frame.filename ?? ''}:${frame.function ?? ''}:${String(frame.lineno ?? '')}`
}

/**
 * Who an event is attributed to: the request's authenticated user, with
 * their browser session and tenant; with no user, this service, with no
 * person profile.
 * @returns The distinct id and the identity properties.
 */
function identityOf(): { distinctId: string; properties: Record<string, unknown> } {
  const context = currentAnalyticsContext()
  const tenantId = requestContextStore.getStore()?.tenant?.tenantId
  const properties: Record<string, unknown> = {}
  if (context.traceId !== undefined) properties.trace_id = context.traceId
  if (context.spanId !== undefined) properties.span_id = context.spanId
  if (tenantId !== undefined) properties.$groups = { tenant: tenantId }
  if (context.userId === undefined) {
    properties.$process_person_profile = false
    return { distinctId: `server:${getEnv().OTEL_SERVICE_NAME}`, properties }
  }
  if (context.posthogSessionId !== undefined) properties.$session_id = context.posthogSessionId
  return { distinctId: context.userId, properties }
}

/**
 * The request or job fields of an event.
 * @param context - The caller's context.
 * @returns `http_*` and `request_id` for a request; `job_*` for a job.
 */
function originOf(context: ErrorContext): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  if (context.http !== undefined) {
    properties.http_method = context.http.method
    properties.http_route = context.http.route
    properties.http_status = context.http.status
    properties.request_id = context.http.requestId
  }
  if (context.job !== undefined) {
    properties.job_queue = context.job.queue
    properties.job_name = context.job.name
    properties.job_attempts = context.job.attemptsMade
  }
  return properties
}

/**
 * Build one signed `$exception` event. `source` is `error`, so the signature
 * covers it with the uuid, the distinct id and `$groups.tenant`.
 * @param error - Anything thrown.
 * @param context - Where it was caught.
 * @param errorId - The event uuid: the `errorId` logs and responses carry.
 * @param at - When it was caught.
 * @returns The event and its fingerprint.
 */
export function buildErrorEvent(
  error: unknown,
  context: ErrorContext,
  errorId: string,
  at: Date
): BuiltErrorEvent {
  const env = getEnv()
  const exceptions = exceptionListOf(error, context.handled)
  const identity = identityOf()
  const properties: Record<string, unknown> = {
    $exception_list: exceptions,
    $exception_level: context.capturePoint === 'process' ? 'fatal' : 'error',
    app: 'api',
    source: 'error',
    capture_point: context.capturePoint,
    environment: env.APP_ENV,
    service: env.OTEL_SERVICE_NAME,
    release: env.APP_VERSION,
    ...originOf(context),
    ...identity.properties,
  }
  const event = toPosthogBatchEvent({
    id: errorId,
    event: '$exception',
    distinctId: identity.distinctId,
    properties,
    occurredAt: at,
  })
  return { event, exceptions, fingerprint: fingerprintOf(exceptions) }
}

/**
 * A frame as a V8 stack line.
 * @param frame - A sent (scrubbed) frame.
 * @returns `    at function (filename:line:column)`.
 */
function frameLine(frame: StackFrame): string {
  const position = `${String(frame.lineno ?? 0)}:${String(frame.colno ?? 0)}`
  return `    at ${frame.function ?? '?'} (${frame.filename ?? '<unknown>'}:${position})`
}

/**
 * The span stand-in for an already scrubbed exception list: its first
 * exception, so a trace never carries what an event may not.
 * @param exceptions - A scrubbed exception list, as `exceptionListOf` builds it.
 * @returns The stand-in.
 */
export function spanErrorOf(exceptions: Exception[]): SpanError {
  const [first] = exceptions
  const name = first?.type ?? 'Error'
  const message = first?.value ?? ''
  const frames = (first?.stacktrace?.frames ?? []).toReversed().map((frame) => frameLine(frame))
  if (frames.length === 0) return { name, message }
  return { name, message, stack: [`${name}: ${message}`, ...frames].join('\n') }
}

/**
 * The span stand-in for a thrown value, built from its scrubbed exception
 * list (`spanErrorOf`). For a 5xx error tracking does not report; one it
 * reports takes the stand-in from the event it built
 * (`reportErrorWithSpan`), so the list is built once.
 * @param error - Anything thrown.
 * @returns The stand-in.
 */
export function scrubbedErrorForSpan(error: unknown): SpanError {
  try {
    return spanErrorOf(exceptionListOf(error))
  } catch {
    return { name: 'Error', message: UNREADABLE_VALUE }
  }
}
