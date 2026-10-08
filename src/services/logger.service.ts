/**
 * @file The one place this codebase writes a log line: a lazily built pino logger
 * with a `level` label, `timestamp` and `message`, a mixin adding correlation ids
 * from the request context and active span, and a formatter that serialises every
 * Error-valued field, redacting database query errors with `redactedForLog`.
 */
import { createRequire } from 'node:module'
import { trace } from '@opentelemetry/api'
import pino, { type DestinationStream, type Logger, type StreamEntry } from 'pino'
import type { PrettyOptions } from 'pino-pretty'
import { getEnv, logFormat, type Env } from '@/configs/env.config'
import { isQueryError, redactedForLog } from '@/errors/postgres-errors'
import { frameLineIndexesOf } from '@/errors/stack-frames'
import { scrubText } from '@/services/errors/error-scrubber.service'
import { requestContextStore } from '@/services/request-context.service'

/**
 * Parse a single V8 stack frame — `at functionName (path:line:col)` or
 * `at path:line:col` — into its file path and line number.
 *
 * Not a regex over the whole frame: a pattern capturing everything up to the
 * last `:line:col` backtracks superlinearly on a long, paren-free frame.
 * Splitting on the last two `:` segments is linear, and a Windows drive letter
 * or `file://` just stays in the path half.
 * @param frame - One line from `Error().stack`, e.g. `    at foo (a.ts:1:2)`.
 * @returns The frame's path and line number, or `undefined` when the line is
 *   not a stack frame shaped like one of the two forms above.
 */
function parseStackFrame(frame: string): { path: string; line: string } | undefined {
  const trimmed = frame.trim()
  if (!trimmed.startsWith('at ')) return undefined

  const afterAt = trimmed.slice(3)
  const parenStart = afterAt.indexOf('(')
  const parenEnd = afterAt.lastIndexOf(')')
  const location =
    parenStart !== -1 && parenEnd !== -1 ? afterAt.slice(parenStart + 1, parenEnd) : afterAt

  const segments = location.split(':')
  const lineNumber = segments.at(-2)
  if (!lineNumber || segments.length < 3 || !/^\d+$/.test(lineNumber)) return undefined

  return { path: segments.slice(0, -2).join(':'), line: lineNumber }
}

/**
 * Parse the first stack frame external to this file to extract the caller's
 * file path and line number, skipping this module's own frames.
 *
 * Strips `file://` prefixes (tsx/vitest), `dist/` prefixes (production), and
 * `src/` prefixes (development) down to a repo-relative path; with neither
 * `dist/` nor `src/`, it keeps the last two path segments.
 * @returns A `path:line` string identifying the caller, or `'unknown'` when
 *   the stack could not be parsed.
 */
export function getCallerSource(): string {
  const stack = new Error('getCallerSource stack capture').stack
  if (!stack) return 'unknown'

  for (const line of stack.split('\n').slice(1)) {
    const frame = parseStackFrame(line)
    if (!frame) continue

    // A suffix check, not a substring one, which would also skip logger.service.test.ts's frames.
    if (frame.path.endsWith('logger.service.ts') || frame.path.endsWith('logger.service.js')) {
      continue
    }

    const rawPath = frame.path.replace(/^file:\/\//, '')
    const distributionIndex = rawPath.lastIndexOf('/dist/')
    const sourceIndex = rawPath.lastIndexOf('/src/')
    const cutIndex = distributionIndex === -1 ? sourceIndex : distributionIndex
    const filePath =
      cutIndex === -1 ? rawPath.split('/').slice(-2).join('/') : rawPath.slice(cutIndex + 1)

    return `${filePath}:${frame.line}`
  }
  return 'unknown'
}

/**
 * Correlation fields for the current call: request/tenant from the request's
 * AsyncLocalStorage context, trace/span from the active OTel span. Absent
 * fields are omitted, never written as undefined.
 * @returns The fields to merge into every record.
 */
function requestContextFields(): Record<string, string> {
  const fields: Record<string, string> = {}
  const context = requestContextStore.getStore()
  if (context?.requestId) fields.requestId = context.requestId
  if (context?.tenant?.tenantId) fields.tenantId = context.tenant.tenantId
  const span = trace.getActiveSpan()
  if (span) {
    const spanContext = span.spanContext()
    fields.traceId = spanContext.traceId
    fields.spanId = spanContext.spanId
  }
  return fields
}

/**
 * How many nodes, the top-level error plus its `.cause` chain, `serializeOneError`
 * walks. Bounded, so a cyclic `.cause` chain ends.
 */
const CAUSE_WALK_DEPTH = 5

/**
 * Serialise one Error, redacting it in place if it carries a database
 * query and bound parameters, else recursing into its own `.cause` (also
 * redacted if necessary). Bounded by `CAUSE_WALK_DEPTH` — four `.cause`
 * hops, five nodes including the top-level error — so a cyclic `.cause`
 * chain ends instead of recursing forever inside a log call.
 * @param error - The error to serialise.
 * @param depth - How many levels of `.cause` have already been walked.
 * @returns A plain object safe to write to the log.
 */
function serializeOneError(error: Error, depth = 0): Record<string, unknown> {
  if (isQueryError(error)) {
    return redactedForLog(error) as Record<string, unknown>
  }
  const plain: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
  const cause = (error as { cause?: unknown }).cause
  if (depth < CAUSE_WALK_DEPTH - 1 && cause instanceof Error) {
    plain.cause = serializeOneError(cause, depth + 1)
  }
  return plain
}

/**
 * Replace every Error-valued key with a plain, redacted object. Walks each
 * error's own `.cause` chain (not only the top-level value) so a query
 * error wrapped by a higher-level Error is still caught before its bound
 * parameters reach the log.
 * @param object - The merged log object pino is about to serialise.
 * @returns A shallow copy with Errors made serialisable and redacted.
 */
function serializeErrors(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    result[key] = value instanceof Error ? serializeOneError(value) : value
  }
  return result
}

/**
 * Configuration for {@link createPinoLogger}.
 */
export interface LoggerOptions {
  level: string
  /**
   * `json` writes pino JSON lines; `pretty` writes pino-pretty text.
   */
  format: 'json' | 'pretty'
  slackWebhookUrl?: string
  slackLogLevel?: string
  /**
   * Where console output goes. Defaults to process.stdout; tests pass a
   * capture stream.
   */
  destination?: DestinationStream
}

/**
 * How long duplicate (same source and message) records are suppressed after
 * the first is sent to Slack, before one summary reports how many were.
 */
const DEDUP_WINDOW_MS = 60_000

const LEVEL_COLORS: Record<string, string> = {
  error: '#E01E5A',
  warn: '#ECB22E',
  info: '#2EB67D',
  debug: '#36C5F0',
}

const LEVEL_EMOJI: Record<string, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🔵',
  debug: '⚪',
}

interface DedupEntry {
  count: number
  firstSeen: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * POST a payload to the Slack webhook. Never throws: a failed alert must not
 * become a second failure. console.error, not logger — re-entering the logger
 * from its own destination would recurse.
 * @param webhookUrl - The Slack incoming-webhook URL.
 * @param payload - The message body.
 */
async function sendToSlack(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      console.error('Slack webhook failed', response.status)
    }
  } catch (error: unknown) {
    console.error('Slack webhook failed', error)
  }
}

/**
 * An ISO 8601 UTC instant, the only form of `timestamp` sent to Slack.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/**
 * A stack as Slack may receive it. Its frame lines, those with a real V8
 * frame's shape after the message (`frameLineIndexesOf`), are scrubbed one
 * by one with `scrubText`, so their paths stay readable; every run of other
 * lines, the message among them, is scrubbed as one text, so a credential
 * split over lines, or behind a message line that starts with `at `, is
 * still seen whole.
 * @param stack - The serialised error's stack.
 * @param message - The serialised error's message, when it has one.
 * @returns The scrubbed stack.
 */
function scrubbedStack(stack: string, message: string | undefined): string {
  const lines = stack.split('\n')
  const frameIndexes = new Set(frameLineIndexesOf(lines, message))
  const parts: string[] = []
  let text: string[] = []
  for (const [index, line] of lines.entries()) {
    if (!frameIndexes.has(index)) {
      text.push(line)
      continue
    }
    if (text.length > 0) parts.push(scrubText(text.join('\n')))
    text = []
    parts.push(scrubText(line))
  }
  if (text.length > 0) parts.push(scrubText(text.join('\n')))
  return parts.join('\n')
}

/**
 * Build the Slack Block Kit payload for one log record. Every text taken
 * from the record (message, source, request id, stack) is scrubbed with
 * the error tracker's `scrubText` first: the channel is a third party, as
 * PostHog is. The time is not scrubbed but validated: it is sent only as an
 * ISO instant, else replaced by the current time.
 * @param info - The parsed JSON log record.
 * @returns The webhook body.
 */
function buildSlackPayload(info: Record<string, unknown>): Record<string, unknown> {
  const level = typeof info.level === 'string' ? info.level : 'error'
  const message = typeof info.message === 'string' ? scrubText(info.message) : ''
  const source = typeof info.source === 'string' ? scrubText(info.source) : 'unknown'
  const requestId = typeof info.requestId === 'string' ? scrubText(info.requestId) : undefined
  // A meta key named `timestamp` overrides pino's own; only an ISO instant is trusted.
  const timestamp =
    typeof info.timestamp === 'string' && ISO_INSTANT.test(info.timestamp)
      ? info.timestamp
      : new Date().toISOString()
  const errorStack =
    info.error && typeof info.error === 'object' && 'stack' in info.error
      ? info.error.stack
      : undefined
  const errorMessage =
    info.error && typeof info.error === 'object' && 'message' in info.error
      ? info.error.message
      : undefined
  const messageOfStack = typeof errorMessage === 'string' ? errorMessage : undefined
  const stack =
    typeof errorStack === 'string' ? scrubbedStack(errorStack, messageOfStack) : undefined

  const fields = [
    { type: 'mrkdwn', text: `*Source:* \`${source}\`` },
    { type: 'mrkdwn', text: `*Time:* ${timestamp}` },
  ]
  if (requestId) {
    fields.push({ type: 'mrkdwn', text: `*Request:* \`${requestId}\`` })
  }

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${LEVEL_EMOJI[level] ?? '⚪'} ${message}`.slice(0, 150) },
    },
    { type: 'section', fields },
  ]
  if (stack) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${stack.slice(0, 2900)}\`\`\`` },
    })
  }

  return { attachments: [{ color: LEVEL_COLORS[level] ?? '#808080', blocks }] }
}

/**
 * Build the "suppressed N duplicates" summary sent when a dedup window
 * closes, its source and message scrubbed as `buildSlackPayload` scrubs them.
 * @param source - The record's source field.
 * @param message - The record's message.
 * @param suppressedCount - How many repeats were swallowed.
 * @returns The webhook body.
 */
function buildSlackSummaryPayload(
  source: string,
  message: string,
  suppressedCount: number
): Record<string, unknown> {
  return {
    text: `⚠️ Suppressed ${suppressedCount} duplicate occurrence${suppressedCount === 1 ? '' : 's'} of "${scrubText(message)}" from \`${scrubText(source)}\` in the last 60s`,
  }
}

/**
 * The body sent in place of a record whose scrub threw: fixed text, nothing
 * from the record.
 */
const SLACK_SCRUB_FAILED_PAYLOAD = {
  text: 'A log record could not be scrubbed and was not forwarded; see the application logs.',
}

/**
 * Error names printed by name when a scrub fails; any other name could carry data.
 */
const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError'])

/**
 * Build a Slack body, or the fixed `SLACK_SCRUB_FAILED_PAYLOAD` if building
 * (the scrub) throws. Reports through `console.error`, never the logger:
 * this destination is part of the logger, and a logger call here would
 * re-enter it. The unscrubbed record is never sent.
 * @param build - Builds the scrubbed body.
 * @returns The body to send.
 */
function safeSlackPayload(build: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return build()
  } catch (error: unknown) {
    console.error(
      'Slack payload scrub failed',
      error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : typeof error
    )
    return SLACK_SCRUB_FAILED_PAYLOAD
  }
}

/**
 * A pino destination that forwards records to Slack, deduplicating by
 * `${source}:${message}` (the raw text, kept in this process only) within a
 * 60 s window: the first occurrence sends at
 * once, repeats are counted, and one summary is sent when the window closes
 * if there were any. Level filtering is done by pino.multistream, not here.
 * @param options - The webhook settings.
 * @param options.webhookUrl - The Slack incoming-webhook URL.
 * @returns A destination for pino.multistream.
 */
export function createSlackDestination(options: { webhookUrl: string }): DestinationStream {
  const dedup = new Map<string, DedupEntry>()
  return {
    write(line: string): void {
      let info: Record<string, unknown>
      try {
        info = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const source = typeof info.source === 'string' ? info.source : 'unknown'
      const message = typeof info.message === 'string' ? info.message : ''
      const key = `${source}:${message}`

      const existing = dedup.get(key)
      if (existing) {
        existing.count++
        return
      }

      const timer = setTimeout(() => {
        const entry = dedup.get(key)
        dedup.delete(key)
        if (entry && entry.count > 1) {
          void sendToSlack(
            options.webhookUrl,
            safeSlackPayload(() => buildSlackSummaryPayload(source, message, entry.count - 1))
          )
        }
      }, DEDUP_WINDOW_MS)
      timer.unref()

      dedup.set(key, { count: 1, firstSeen: Date.now(), timer })
      void sendToSlack(
        options.webhookUrl,
        safeSlackPayload(() => buildSlackPayload(info))
      )
    },
  }
}

const requireCjs = createRequire(import.meta.url)

/**
 * Loads pino-pretty. A mutable object, so tests can swap `load` to force the
 * MODULE_NOT_FOUND path in {@link createPrettyStream}.
 */
export const pinoPrettyLoader = {
  load: (): { build: (options: PrettyOptions) => DestinationStream } =>
    requireCjs('pino-pretty') as { build: (options: PrettyOptions) => DestinationStream },
}

/**
 * Human-readable output, used when the format is `pretty`. pino-pretty is a
 * devDependency and is pruned from the production image, so an image run
 * with LOG_FORMAT=pretty (or APP_ENV=local) throws MODULE_NOT_FOUND below;
 * fall back to the raw JSON destination instead of crashing the first log
 * call.
 * @param destination - Where the pretty text goes.
 * @returns A pino destination.
 */
function createPrettyStream(destination: DestinationStream): DestinationStream {
  let build: (options: PrettyOptions) => DestinationStream
  try {
    ;({ build } = pinoPrettyLoader.load())
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
      return destination
    }
    throw error
  }
  return build({
    destination,
    colorize: destination === process.stdout && process.stdout.isTTY,
    messageKey: 'message',
    timestampKey: 'timestamp',
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'source,requestId',
    messageFormat: (log, messageKey) => {
      const source = typeof log.source === 'string' ? ` [${log.source}]` : ''
      const requestId = typeof log.requestId === 'string' ? ` (${log.requestId.slice(0, 8)})` : ''
      const message =
        typeof log[messageKey] === 'string' ? log[messageKey] : JSON.stringify(log[messageKey])
      return `${source}${requestId} ${message}`.trim()
    },
  })
}

/**
 * The levels the env schema allows for LOG_LEVEL and SLACK_LOG_LEVEL, checked
 * again for `createPinoLogger`'s direct callers.
 */
const LEVELS = new Set(['error', 'warn', 'info', 'debug'])

/**
 * Narrow an arbitrary level string to one pino.multistream accepts, falling
 * back to 'info' for anything outside the closed set LOG_LEVEL/
 * SLACK_LOG_LEVEL are validated against.
 * @param level - The requested level.
 * @returns A valid pino.Level.
 */
function toPinoLevel(level: string): pino.Level {
  return LEVELS.has(level) ? (level as pino.Level) : 'info'
}

/**
 * Build a pino logger that writes JSON or pino-pretty text, per `format`.
 * With a Slack webhook, records at or above slackLogLevel are also sent to
 * Slack via pino.multistream. pino's default `err` serializer is replaced
 * with a pass-through, so `err` keeps the shape `serializeErrors` gives every
 * Error field.
 * @param options - Level, format, Slack settings, optional destination.
 * @returns The pino logger.
 */
export function createPinoLogger(options: LoggerOptions): Logger {
  const base = options.destination ?? process.stdout
  const consoleStream = options.format === 'json' ? base : createPrettyStream(base)

  const streams: StreamEntry[] = [
    // Explicit: a multistream entry defaults to 'info' and would drop debug lines.
    { level: toPinoLevel(options.level), stream: consoleStream },
  ]
  if (options.slackWebhookUrl) {
    streams.push({
      level: toPinoLevel(options.slackLogLevel ?? 'error'),
      stream: createSlackDestination({ webhookUrl: options.slackWebhookUrl }),
    })
  }

  return pino(
    {
      level: options.level,
      // eslint-disable-next-line unicorn/no-null -- pino's own LoggerOptions type requires `null`, not `undefined`, to suppress the default pid/hostname bindings
      base: null,
      messageKey: 'message',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      mixin: requestContextFields,
      // Mixin wins, so a caller's meta cannot spoof requestId, tenantId, traceId or spanId.
      mixinMergeStrategy: (mergeObject, mixinObject) => Object.assign(mergeObject, mixinObject),
      formatters: {
        level: (label) => ({ level: label }),
        log: serializeErrors,
      },
      serializers: { err: (value: unknown) => value },
    },
    pino.multistream(streams)
  )
}

/**
 * Map the validated environment to the process logger's options.
 * @param env - The logging slice of the validated environment.
 * @returns Options for `createPinoLogger`.
 */
export function loggerOptionsFromEnv(
  env: Pick<Env, 'LOG_LEVEL' | 'LOG_FORMAT' | 'APP_ENV' | 'SLACK_WEBHOOK_URL' | 'SLACK_LOG_LEVEL'>
): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    format: logFormat(env),
    ...(env.SLACK_WEBHOOK_URL !== undefined && { slackWebhookUrl: env.SLACK_WEBHOOK_URL }),
    slackLogLevel: env.SLACK_LOG_LEVEL,
  }
}

const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    cached ??= createPinoLogger(loggerOptionsFromEnv(getEnv()))
    return cached
  }
})()

/**
 * The process-wide logger. Lazily backed by a single pino instance
 * (`getLogger()`, memoised the same way `getEnv()` is) so importing this
 * module never constructs a destination as a side effect.
 *
 * Each level guards itself with pino's own `isLevelEnabled()` check before
 * doing any work — in particular before paying for `getCallerSource()`'s
 * `new Error().stack` capture, so `logger.debug()` on a hot path costs
 * nothing when `LOG_LEVEL=info`.
 */
export const logger = {
  error(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('error')) return
    l.error({ ...meta, source: getCallerSource() }, message)
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('warn')) return
    l.warn({ ...meta, source: getCallerSource() }, message)
  },
  info(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('info')) return
    l.info({ ...meta, source: getCallerSource() }, message)
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isLevelEnabled('debug')) return
    l.debug({ ...meta, source: getCallerSource() }, message)
  },
}
