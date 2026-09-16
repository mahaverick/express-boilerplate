// src/services/logger.service.ts
//
// The one place anything in this codebase should write a log line. A
// Winston logger, lazily constructed (same pattern as getEnv()/getRedis()) so
// importing this module never has a side effect, plus two format steps that
// exist because of two Winston/JS gotchas: a bare Error serializes to "{}"
// through JSON.stringify (message/stack/name are non-enumerable), and Winston
// has no built-in way to pull correlation data out of an AsyncLocalStorage
// context — see serializeErrors and addRequestContext below.
import { createLogger, format, transports, type Logger } from 'winston'
import Transport from 'winston-transport'
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

const addRequestContext = format((info) => {
  const context = requestContextStore.getStore()
  if (context?.requestId) {
    info.requestId = context.requestId
  }
  return info
})

/**
 * Walk meta and convert Error instances to serializable objects.
 * `JSON.stringify(new Error(...))` is `"{}"` because `message`, `stack`, and
 * `name` are non-enumerable. This format step ensures they survive in
 * production JSON output.
 */
const serializeErrors = format((info) => {
  for (const [key, value] of Object.entries(info)) {
    if (value instanceof Error) {
      info[key] = { name: value.name, message: value.message, stack: value.stack }
    }
  }
  return info
})

// `...meta` deliberately keeps Winston's internal Symbol.for('level')/
// Symbol.for('splat') entries rather than destructuring them away:
// JSON.stringify (used below) ignores symbol-keyed properties by spec, so
// they never reach the printed output regardless.
const developmentFormat = format.printf((info) => {
  const { level, message, source, requestId, timestamp, ...meta } = info
  const time = typeof timestamp === 'string' ? timestamp : ''
  const sourceLabel = typeof source === 'string' ? ` [${source}]` : ''
  const requestIdLabel = typeof requestId === 'string' ? ` (${requestId.slice(0, 8)})` : ''
  const messageText = typeof message === 'string' ? message : JSON.stringify(message)
  const extra = Object.keys(meta).length > 0 ? `\n  ${JSON.stringify(meta)}` : ''
  return `${time} ${level}${sourceLabel}${requestIdLabel} ${messageText}${extra}`
})

interface LoggerOptions {
  level: string
  isProduction: boolean
  slackWebhookUrl?: string
  slackLogLevel?: string
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
 * A Winston transport that POSTs log entries to a Slack Incoming Webhook.
 *
 * Deduplicates by `source:message`: the first occurrence within a 60s
 * window is sent immediately, every repeat in that window is counted but
 * suppressed, and — only if there were repeats — a single summary message
 * reports the suppressed count once the window closes.
 */
class SlackTransport extends Transport {
  private readonly webhookUrl: string
  private readonly dedup = new Map<string, DedupEntry>()

  constructor(options: { webhookUrl: string; level?: string }) {
    super({ level: options.level ?? 'error' })
    this.webhookUrl = options.webhookUrl
  }

  private async sendToSlack(payload: Record<string, unknown>): Promise<void> {
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (error: unknown) {
      // Direct console.error, NOT logger.error — using the logger here would
      // re-enter this transport's own log() and create a feedback loop where
      // a failed Slack send generates another Slack send that also fails,
      // forever. No `eslint-disable` comment sits above this line: this
      // file is exempted at the FILE level from no-restricted-properties
      // (eslint.config.mjs), which already covers it, and this repo's own
      // `eslint --fix` (run by lint-staged on every commit) deletes an
      // inline disable the moment it becomes an unused directive — verified
      // empirically when Task 3 added the rule and the exemption in the
      // same commit as an inline disable here; the fix step of the very
      // commit that added it removed it again.
      console.error('Slack webhook failed', error)
    }
  }

  // `info`'s values are `unknown` (winston's own Info shape carries no
  // guarantee about what a caller passed as meta), so every field below is
  // narrowed with a `typeof` check rather than blindly `String(...)`-coerced
  // — a plain object landing in `info.source` would otherwise stringify to
  // the meaningless "[object Object]" (@typescript-eslint/no-base-to-string
  // catches exactly this), the same reasoning `developmentFormat` above
  // already applies to `source`/`requestId`.
  private buildPayload(info: Record<string, unknown>): Record<string, unknown> {
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
        text: {
          type: 'plain_text',
          text: `${LEVEL_EMOJI[level] ?? '⚪'} ${message}`.slice(0, 150),
        },
      },
      { type: 'section', fields },
    ]

    if (stack) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${stack.slice(0, 2900)}\`\`\`` },
      })
    }

    return {
      attachments: [
        {
          color: LEVEL_COLORS[level] ?? '#808080',
          blocks,
        },
      ],
    }
  }

  private buildSummaryPayload(
    source: string,
    message: string,
    suppressedCount: number
  ): Record<string, unknown> {
    return {
      text: `⚠️ Suppressed ${suppressedCount} duplicate occurrence${suppressedCount === 1 ? '' : 's'} of "${message}" from \`${source}\` in the last 60s`,
    }
  }

  override log(info: Record<string, unknown>, callback: () => void): void {
    const source = typeof info.source === 'string' ? info.source : 'unknown'
    const message = typeof info.message === 'string' ? info.message : ''
    const key = `${source}:${message}`

    const existing = this.dedup.get(key)
    if (existing) {
      existing.count++
      callback()
      return
    }

    const timer = setTimeout(() => {
      const entry = this.dedup.get(key)
      this.dedup.delete(key)
      if (entry && entry.count > 1) {
        // Fire-and-forget: sendToSlack handles its own failures internally
        // (see its own comment), so there is nothing for a setTimeout
        // callback to await or react to.
        void this.sendToSlack(this.buildSummaryPayload(source, message, entry.count - 1))
      }
    }, DEDUP_WINDOW_MS)
    // Without this, the pending timer keeps a module-scope singleton (and
    // therefore the Node event loop) alive past its test, hanging vitest
    // workers. unref() lets the process exit naturally once nothing else is
    // pending.
    timer.unref()

    this.dedup.set(key, { count: 1, firstSeen: Date.now(), timer })
    // Fire-and-forget for the same reason as above — Winston's `callback()`
    // signals "this transport is done with this entry", which must happen
    // synchronously so the logger doesn't block on network I/O.
    void this.sendToSlack(this.buildPayload(info))
    callback()
  }
}

/**
 * Create a Winston logger with explicit options.
 *
 * Exported so tests can construct both production and development variants
 * without depending on `getEnv()` memoisation — same precedent as
 * `startServer(port)` in `server.ts`.
 * @param options - Logger configuration.
 * @returns A configured Winston Logger.
 */
export function createWinstonLogger(options: LoggerOptions): Logger {
  const consoleFormat = options.isProduction
    ? format.combine(addRequestContext(), format.timestamp(), serializeErrors(), format.json())
    : format.combine(
        addRequestContext(),
        format.timestamp({ format: 'HH:mm:ss' }),
        serializeErrors(),
        format.colorize(),
        developmentFormat
      )

  const logTransports: Transport[] = [new transports.Console({ format: consoleFormat })]

  if (options.slackWebhookUrl) {
    logTransports.push(
      new SlackTransport({
        webhookUrl: options.slackWebhookUrl,
        level: options.slackLogLevel ?? 'error',
      })
    )
  }

  return createLogger({
    level: options.level,
    transports: logTransports,
  })
}

const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    const env = getEnv()
    cached ??= createWinstonLogger({
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
 * The process-wide logger. Lazily backed by a single Winston instance
 * (`getLogger()`, memoised the same way `getEnv()` is) so importing this
 * module never constructs a transport as a side effect.
 *
 * Each level guards itself with Winston's own `isXEnabled()` check before
 * doing any work — in particular before paying for `getCallerSource()`'s
 * `new Error().stack` capture, so `logger.debug()` on a hot path costs
 * nothing when `LOG_LEVEL=info`.
 */
export const logger = {
  error(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isErrorEnabled()) return
    l.error(message, { ...meta, source: getCallerSource() })
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isWarnEnabled()) return
    l.warn(message, { ...meta, source: getCallerSource() })
  },
  info(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isInfoEnabled()) return
    l.info(message, { ...meta, source: getCallerSource() })
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    const l = getLogger()
    if (!l.isDebugEnabled()) return
    l.debug(message, { ...meta, source: getCallerSource() })
  },
}
