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

  return createLogger({
    level: options.level,
    transports: [new transports.Console({ format: consoleFormat })],
  })
}

const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    cached ??= createWinstonLogger({
      level: getEnv().LOG_LEVEL,
      isProduction: getEnv().NODE_ENV === 'production',
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
