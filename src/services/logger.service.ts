// src/services/logger.service.ts
//
// The one place anything in this codebase should write a log line. A pino
// logger, lazily constructed (same pattern as getEnv()/getRedis()) so
// importing this module never has a side effect. It keeps the JSON shape the
// winston version had — `level` as a label, `timestamp`, `message` — plus a
// mixin that pulls correlation data out of AsyncLocalStorage and the active
// span, and a formatter that turns any Error-valued field into
// { name, message, stack } (JSON.stringify of a bare Error is "{}").
import { createRequire } from 'node:module'
import { trace } from '@opentelemetry/api'
import pino, { type DestinationStream, type Logger, type StreamEntry } from 'pino'
import type { PrettyOptions } from 'pino-pretty'
import { getEnv } from '@/configs/env.config'
import { requestContextStore } from '@/middlewares/request-context.middleware'

/**
 * Parse a single V8 stack frame — `at functionName (path:line:col)` or
 * `at path:line:col` — into its file path and line number.
 *
 * Deliberately not a regex over the whole frame: a pattern that tries to
 * capture "everything up to the last `:line:col`" with nested optional
 * groups is exactly the shape that backtracks superlinearly on a long,
 * paren-free frame. Splitting on the last two `:`-separated segments does
 * the same job in linear time and, as a side effect, also copes with a
 * Windows drive letter (`C:\...`) the same way it copes with `file://`: both
 * just become extra segments swallowed into the path half of the split.
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
 * file path and line number.
 *
 * Strips `file://` prefixes (tsx/vitest), `dist/` prefixes (production), and
 * `src/` prefixes (development) down to a repo-relative path.
 * @returns A `path:line` string identifying the caller, or `'unknown'` when
 *   the stack could not be parsed.
 */
export function getCallerSource(): string {
  const stack = new Error('getCallerSource stack capture').stack
  if (!stack) return 'unknown'

  for (const line of stack.split('\n').slice(1)) {
    const frame = parseStackFrame(line)
    if (!frame) continue

    // Skip frames inside this module itself (getCallerSource's own frame,
    // and the logger.error/warn/info/debug wrapper that called it) so the
    // result names the actual external caller. A SUFFIX check on the parsed
    // path, not `line.includes('logger.service')`: this file's own test,
    // tests/unit/services/logger.service.test.ts, contains "logger.service"
    // as a substring of its own name — an `includes` check would skip the
    // test's own frame too and walk straight into Vitest's internal runner
    // frames, which is exactly the false positive this was caught by.
    if (frame.path.endsWith('logger.service.ts') || frame.path.endsWith('logger.service.js')) {
      continue
    }

    const rawPath = frame.path.replace(/^file:\/\//, '')
    const distributionIndex = rawPath.lastIndexOf('/dist/')
    const sourceIndex = rawPath.lastIndexOf('/src/')
    // Whichever of /dist/ or /src/ appears (a built vs. a dev/test run),
    // cut everything before it so the printed path is repo-relative; when
    // neither appears, fall back to the last two path segments.
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
 * Replace every Error-valued key with a plain { name, message, stack } object.
 * @param object - The merged log object pino is about to serialise.
 * @returns A shallow copy with Errors made serialisable.
 */
function serializeErrors(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    result[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
  }
  return result
}

/**
 * Configuration for {@link createPinoLogger}.
 */
export interface LoggerOptions {
  level: string
  isProduction: boolean
  slackWebhookUrl?: string
  slackLogLevel?: string
  /**
   * Where console output goes. Defaults to process.stdout; tests pass a
   * capture stream.
   */
  destination?: DestinationStream
}

// How long duplicate (same source + message) log entries are suppressed
// after the first one triggers a Slack send, before a single summary
// message reports how many were suppressed.
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
 * Build the Slack Block Kit payload for one log record.
 * @param info - The parsed JSON log record.
 * @returns The webhook body.
 */
function buildSlackPayload(info: Record<string, unknown>): Record<string, unknown> {
  const level = typeof info.level === 'string' ? info.level : 'error'
  const message = typeof info.message === 'string' ? info.message : ''
  const source = typeof info.source === 'string' ? info.source : 'unknown'
  const requestId = typeof info.requestId === 'string' ? info.requestId : undefined
  const timestamp = typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString()
  const errorStack =
    info.error && typeof info.error === 'object' && 'stack' in info.error
      ? info.error.stack
      : undefined
  const stack = typeof errorStack === 'string' ? errorStack : undefined

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
 * Build the "suppressed N duplicates" summary sent when a dedup window closes.
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
    text: `⚠️ Suppressed ${suppressedCount} duplicate occurrence${suppressedCount === 1 ? '' : 's'} of "${message}" from \`${source}\` in the last 60s`,
  }
}

/**
 * A pino destination that forwards records to Slack, deduplicating by
 * `${source}:${message}` within a 60 s window: the first occurrence sends at
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
            buildSlackSummaryPayload(source, message, entry.count - 1)
          )
        }
      }, DEDUP_WINDOW_MS)
      timer.unref()

      dedup.set(key, { count: 1, firstSeen: Date.now(), timer })
      void sendToSlack(options.webhookUrl, buildSlackPayload(info))
    },
  }
}

const requireCjs = createRequire(import.meta.url)

/**
 * Loads pino-pretty via requireCjs(), indirected through this mutable
 * object rather than called directly, so tests can swap `load` with
 * `tests/helpers/mutate.ts`'s `withMutatedMethod` to force the
 * MODULE_NOT_FOUND path in {@link createPrettyStream} below without
 * touching the real module resolution machinery.
 */
export const pinoPrettyLoader = {
  load: (): { build: (options: PrettyOptions) => DestinationStream } =>
    requireCjs('pino-pretty') as { build: (options: PrettyOptions) => DestinationStream },
}

/**
 * Human-readable development output. pino-pretty is a devDependency, only
 * reached when isProduction is false — but the production image is built
 * with NODE_ENV baked into its start command, not into the image itself, so
 * a pruned image can still be launched with NODE_ENV=development/test (e.g.
 * a one-off debug run). Dev deps are pruned from that image, so the require
 * below throws MODULE_NOT_FOUND in that case; fall back to the raw JSON
 * destination instead of crashing the first log call.
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

// The env schema (env.config.ts) already restricts LOG_LEVEL and
// SLACK_LOG_LEVEL to these four values — this set is belt-and-braces
// validation for createPinoLogger's own direct callers (the tests), not new
// runtime behaviour, and lets `options.level`/`options.slackLogLevel` reach
// pino.multistream's StreamEntry without an `as pino.Level` cast.
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
 * Build a pino logger. Production writes JSON; development writes
 * pino-pretty text. With a Slack webhook, records at or above
 * slackLogLevel are also sent to Slack via pino.multistream.
 * @param options - Level, format, Slack settings, optional destination.
 * @returns The pino logger.
 */
export function createPinoLogger(options: LoggerOptions): Logger {
  const base = options.destination ?? process.stdout
  const consoleStream = options.isProduction ? base : createPrettyStream(base)

  const streams: StreamEntry[] = [
    // level MUST be explicit: a multistream entry defaults to 'info', which
    // would silently drop debug lines when LOG_LEVEL=debug.
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
      // null, not undefined: pino's own LoggerOptions types `base` as
      // `{ ... } | null` (no `undefined` in the union), so under this
      // tsconfig's exactOptionalPropertyTypes, `base: undefined` fails to
      // typecheck even though it works identically at runtime. `null` is
      // also pino's own documented way to drop the default pid/hostname
      // bindings, so this is the idiomatic spelling, not just the one that
      // compiles.
      // eslint-disable-next-line unicorn/no-null -- pino's own LoggerOptions type requires `null`, not `undefined`, to suppress the default pid/hostname bindings
      base: null,
      messageKey: 'message',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      mixin: requestContextFields,
      // pino's default merge lets the logged object's own fields overwrite
      // the mixin's — so a caller passing `requestId` (or `tenantId`,
      // `traceId`, `spanId`) in meta would silently spoof correlation data
      // that is supposed to come only from the request's own
      // AsyncLocalStorage context / active span. Reversing the merge order
      // makes the mixin win, restoring the winston-era guarantee that
      // callers cannot override correlation fields.
      mixinMergeStrategy: (mergeObject, mixinObject) => Object.assign(mergeObject, mixinObject),
      formatters: {
        level: (label) => ({ level: label }),
        log: serializeErrors,
      },
      // pino's own default `err` serializer would otherwise re-process the
      // { name, message, stack } shape serializeErrors already produced,
      // turning it into { type: 'Object', message, stack, name } — losing
      // the clean shape and adding a misleading `type`. Pass it through
      // untouched so `err` serialises exactly like every other Error field.
      serializers: { err: (value: unknown) => value },
    },
    pino.multistream(streams)
  )
}

const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    const env = getEnv()
    cached ??= createPinoLogger({
      level: env.LOG_LEVEL,
      isProduction: env.NODE_ENV === 'production',
      // Spread rather than `slackWebhookUrl: env.SLACK_WEBHOOK_URL` directly:
      // tsconfig's `exactOptionalPropertyTypes` treats an optional property
      // as "string or absent", not "string or undefined", so explicitly
      // assigning `undefined` to it is a type error. Same pattern
      // mailer.config.ts uses for SMTP_USER/SMTP_PASS.
      ...(env.SLACK_WEBHOOK_URL !== undefined && { slackWebhookUrl: env.SLACK_WEBHOOK_URL }),
      slackLogLevel: env.SLACK_LOG_LEVEL,
    })
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
