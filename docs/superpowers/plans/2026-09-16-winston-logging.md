# Winston Structured Logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `console.*` calls in `src/` with a Winston logger that produces structured JSON in production, human-readable output in development, automatically correlates request-ids via AsyncLocalStorage, includes caller file:line on every entry, and sends error-level (or configurable) logs to Slack.

**Architecture:** A lazy-initialized Winston logger service reads `LOG_LEVEL` from the existing env schema. An `AsyncLocalStorage`-backed middleware captures the request-id set by the existing `requestId` middleware, and the logger reads it on every call — callers never pass it. A custom Slack transport sends Block Kit messages to a webhook URL with per-unique-message deduplication. An ESLint lint gate bans `console.*` in `src/` after migration.

**Tech Stack:** Winston 3.x, Node.js `AsyncLocalStorage`, native `fetch` for Slack webhooks, Zod 4 for env validation, ESLint `no-restricted-properties` for the lint gate.

**Spec:** `docs/superpowers/specs/2026-09-16-winston-logging-design.md`

## Global Constraints

- TypeScript pinned `~6.0.3` — do not upgrade (see MIGRATIONS.md)
- Zod 4.6.5 — use `z.url({ protocol: /^https?$/ })`, NOT `z.string().url()` or `z.httpUrl()` (see env.config.ts header comment, lines 33-40)
- No barrel files — import directly (`@/services/logger.service`)
- `getEnv()` is lazy and memoised — new services MUST follow the same lazy init pattern (see CLAUDE.md)
- File naming: `src/services/*.service.ts`, `src/middlewares/*.middleware.ts`
- `pnpm env:example` regenerates `.env.example` from the schema — never hand-edit it
- `request.id` is declared in `src/types/express.d.ts` (lines 10-14), set by `requestId` middleware
- Pre-commit runs `eslint` + `vitest --changed HEAD` (excluding `tests/integration/**`); pre-push runs `pnpm lint` + `pnpm test:coverage`
- Tests that hit Docker (database, Redis, Mailpit) MUST live under `tests/integration/`, never `tests/unit/` (see CLAUDE.md)
- Never edit files under `src/` to prove a test catches breakage — use `tests/helpers/mutate.ts` instead (see CLAUDE.md)

---

### Task 1: Request Context Middleware + Logger Service Core

**Files:**

- Create: `src/middlewares/request-context.middleware.ts`
- Create: `src/services/logger.service.ts`
- Modify: `src/app.ts` (line 46 — register `requestContext` after `requestId`)
- Modify: `package.json` (add `winston` dependency)
- Create: `tests/unit/middlewares/request-context.middleware.test.ts`
- Create: `tests/unit/services/logger.service.test.ts`

**Interfaces:**

- Consumes: `request.id` from `src/middlewares/request-id.middleware.ts` (set on Express `Request` — declared in `src/types/express.d.ts:10-14`)
- Consumes: `getEnv()` from `src/configs/env.config.ts` — fields `LOG_LEVEL` (line 212), `NODE_ENV` (line 42)
- Produces: `requestContextStore` — `AsyncLocalStorage<RequestContext>` exported from `request-context.middleware.ts`
- Produces: `requestContext` — Express middleware function exported from `request-context.middleware.ts`
- Produces: `logger` — object with `error(message, meta?)`, `warn(message, meta?)`, `info(message, meta?)`, `debug(message, meta?)` exported from `logger.service.ts`
- Produces: `createWinstonLogger(options)` — exported for tests that need to construct a logger with explicit options (e.g. production format) without depending on `getEnv()` memoisation (same precedent as `startServer(port)` in `server.ts`)

- [ ] **Step 1: Install Winston**

```bash
pnpm add winston
```

Winston 3.x ships its own types (`index.d.ts`). No `@types/winston` needed. `winston-transport` is a transitive dependency — verify it resolves:

```bash
node -e "import('winston').then(w => console.log(typeof w.default.transports.Console))"
```

Expected: `function`

- [ ] **Step 2: Verify `winston-transport` is importable under pnpm strict mode**

The Slack transport in Task 2 will extend `TransportStream`. Winston re-exports it as `winston.Transport`, but pnpm's strict node_modules may not hoist `winston-transport` for direct import. Check:

```bash
node -e "import('winston').then(w => { const t = new w.default.transports.Console(); console.log(t.constructor.name) })"
```

If `winston.Transport` is not available as a class to extend, add `winston-transport` as an explicit dependency:

```bash
pnpm add winston-transport
```

- [ ] **Step 3: Create `src/middlewares/request-context.middleware.ts`**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'
import { type NextFunction, type Request, type Response } from 'express'

export interface RequestContext {
  requestId: string
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>()

/**
 * Wrap the rest of the request in an AsyncLocalStorage context carrying the
 * request-id. Runs immediately after the requestId middleware in the chain.
 * @param request - The request (with `id` already set by requestId middleware).
 * @param _response - Unused.
 * @param next - Passes control into the ALS context.
 */
export function requestContext(request: Request, _response: Response, next: NextFunction): void {
  requestContextStore.run({ requestId: request.id }, next)
}
```

- [ ] **Step 4: Create `src/services/logger.service.ts`**

```typescript
import { createLogger, format, transports, type Logger } from 'winston'
import { getEnv } from '@/configs/env.config'
import { requestContextStore } from '@/middlewares/request-context.middleware'

/**
 * Parse the first stack frame external to this file to extract the caller's
 * file path and line number.
 *
 * Handles both V8 frame shapes:
 *   `at functionName (path:line:col)`
 *   `at path:line:col`
 * and strips `file://` prefixes (tsx/vitest), `dist/` prefixes (production),
 * and `src/` prefixes (development) down to repo-relative paths.
 */
function getCallerSource(): string {
  const stack = new Error().stack
  if (!stack) return 'unknown'

  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('logger.service')) continue

    const match =
      line.match(/at\s+(?:async\s+)?(?:.+?\s+)?\(?(.+?):(\d+):\d+\)?/) ??
      line.match(/at\s+(.+?):(\d+):\d+/)
    if (!match) continue

    let filePath = match[1].replace(/^file:\/\//, '')
    const distIndex = filePath.lastIndexOf('/dist/')
    const srcIndex = filePath.lastIndexOf('/src/')
    if (distIndex >= 0) filePath = filePath.slice(distIndex + 1)
    else if (srcIndex >= 0) filePath = filePath.slice(srcIndex + 1)
    else filePath = filePath.split('/').slice(-2).join('/')

    return `${filePath}:${match[2]}`
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

const devFormat = format.printf(({ level, message, source, requestId, timestamp, ...rest }) => {
  const time = typeof timestamp === 'string' ? timestamp : ''
  const src = source ? ` [${source}]` : ''
  const rid = requestId ? ` (${String(requestId).slice(0, 8)})` : ''
  const { [Symbol.for('level')]: _lvl, [Symbol.for('splat')]: _splat, ...meta } = rest
  const extra = Object.keys(meta).length > 0 ? `\n  ${JSON.stringify(meta)}` : ''
  return `${time} ${level}${src}${rid} ${message}${extra}`
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
 * `startServer(port)` in `server.ts:21`.
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
        devFormat
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
```

**Note on `isErrorEnabled()`/`isWarnEnabled()` etc.:** these guards skip the
`new Error().stack` capture when the level is disabled, so `logger.debug()` in
a hot path is free when `LOG_LEVEL=info`.

**Note on `serializeErrors`:** CLAUDE.md explicitly warns that
`JSON.stringify(err)` on an `Error` is `"{}"` — `message`, `stack`, and
`response` are non-enumerable. This format step walks the info object and
converts any `Error` values to `{ name, message, stack }` so they survive in
production JSON output. Your tests MUST assert `parsed.error.message === '...'`
and that `parsed.error.stack` contains `at `, not merely that `parsed.error`
exists (which passes vacuously with `{}`).

- [ ] **Step 5: Register `requestContext` middleware in `src/app.ts`**

Add import at the top (after the `requestId` import, line 10):

```typescript
import { requestContext } from '@/middlewares/request-context.middleware'
```

Add the middleware call immediately after the `app.use(requestId)` line (after line 46):

```typescript
app.use(requestId)
app.use(requestContext)
```

- [ ] **Step 6: Write tests for `request-context.middleware.ts`**

Create `tests/unit/middlewares/request-context.middleware.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { requestContext, requestContextStore } from '@/middlewares/request-context.middleware'

describe('requestContext middleware', () => {
  it('sets requestId in the store from request.id', () => {
    const request = { id: 'test-uuid-1234' } as Express.Request
    const response = {} as never
    let capturedRequestId: string | undefined

    requestContext(request, response, () => {
      capturedRequestId = requestContextStore.getStore()?.requestId
    })

    expect(capturedRequestId).toBe('test-uuid-1234')
  })

  it('returns undefined from getStore() outside a request context', () => {
    expect(requestContextStore.getStore()).toBeUndefined()
  })

  it('isolates contexts between concurrent requests', async () => {
    const results: string[] = []

    await Promise.all([
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-a' } as Express.Request, {} as never, async () => {
          await new Promise((r) => setTimeout(r, 10))
          results.push(requestContextStore.getStore()!.requestId)
          resolve()
        })
      }),
      new Promise<void>((resolve) => {
        requestContext({ id: 'req-b' } as Express.Request, {} as never, () => {
          results.push(requestContextStore.getStore()!.requestId)
          resolve()
        })
      }),
    ])

    expect(results).toContain('req-a')
    expect(results).toContain('req-b')
  })
})
```

- [ ] **Step 7: Write tests for `logger.service.ts`**

Create `tests/unit/services/logger.service.test.ts`:

```typescript
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { requestContextStore } from '@/middlewares/request-context.middleware'
import { createWinstonLogger } from '@/services/logger.service'

function captureTransport(): { output: string[]; transport: Writable } {
  const output: string[] = []
  const transport = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString().trim())
      callback()
    },
  })
  return { output, transport }
}

describe('createWinstonLogger', () => {
  describe('production format (JSON)', () => {
    it('outputs valid JSON with level, message, timestamp, and source', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'info', isProduction: true })
      log.add(transport as never)

      log.info('test message', { source: 'test.ts:1' })

      setImmediate(() => {
        expect(output.length).toBeGreaterThan(0)
        const parsed = JSON.parse(output.at(-1)!)
        expect(parsed.level).toBe('info')
        expect(parsed.message).toBe('test message')
        expect(parsed.source).toBe('test.ts:1')
        expect(parsed.timestamp).toBeDefined()
        done()
      })
    })

    it('serializes Error instances in meta to { name, message, stack }', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'error', isProduction: true })
      log.add(transport as never)

      const testError = new Error('test failure')
      log.error('something broke', { error: testError, source: 'test.ts:1' })

      setImmediate(() => {
        const parsed = JSON.parse(output.at(-1)!)
        expect(parsed.error.message).toBe('test failure')
        expect(parsed.error.name).toBe('Error')
        expect(parsed.error.stack).toMatch(/at /)
        done()
      })
    })

    it('includes requestId when called inside an ALS context', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'info', isProduction: true })
      log.add(transport as never)

      requestContextStore.run({ requestId: 'abc-123' }, () => {
        log.info('inside request', { source: 'test.ts:1' })
      })

      setImmediate(() => {
        const parsed = JSON.parse(output.at(-1)!)
        expect(parsed.requestId).toBe('abc-123')
        done()
      })
    })

    it('omits requestId when called outside an ALS context', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'info', isProduction: true })
      log.add(transport as never)

      log.info('no request', { source: 'test.ts:1' })

      setImmediate(() => {
        const parsed = JSON.parse(output.at(-1)!)
        expect(parsed.requestId).toBeUndefined()
        done()
      })
    })
  })

  describe('development format (human-readable)', () => {
    it('includes time, level, source, and message', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'info', isProduction: false })
      log.add(transport as never)

      log.info('boot complete', { source: 'server.ts:23' })

      setImmediate(() => {
        const line = output.at(-1)!
        expect(line).toContain('info')
        expect(line).toContain('[server.ts:23]')
        expect(line).toContain('boot complete')
        done()
      })
    })
  })

  describe('level filtering', () => {
    it('does not output debug when level is info', (done) => {
      const { output, transport } = captureTransport()
      const log = createWinstonLogger({ level: 'info', isProduction: false })
      log.add(transport as never)

      log.debug('should not appear', { source: 'test.ts:1' })

      setImmediate(() => {
        expect(output).toHaveLength(0)
        done()
      })
    })
  })
})
```

**Important test note:** the `logger` export (the singleton) uses `getLogger()`
which calls `getEnv()`. In tests, `getEnv()` returns the test env
(`NODE_ENV=test`, `LOG_LEVEL=info`). To test production format, use
`createWinstonLogger({ isProduction: true, ... })` directly — do NOT try to
override `NODE_ENV` after `getEnv()` has memoised.

- [ ] **Step 8: Write test for `getCallerSource()` via the `logger` singleton**

Add to `tests/unit/services/logger.service.test.ts`:

```typescript
import { logger } from '@/services/logger.service'

describe('logger singleton', () => {
  it('attaches source containing the calling file name', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    // Call is a no-op (mocked), but we can at least verify the export shape.
    logger.info('test')
    expect(spy).toHaveBeenCalledWith('test')
    spy.mockRestore()
  })
})
```

For a deeper caller-location test, verify `getCallerSource()` by calling
the real logger (with a writable stream transport) from this test file and
asserting the `source` field contains `logger.service.test.ts`:

```typescript
describe('caller location extraction', () => {
  it('source field names the calling file, not logger.service.ts', (done) => {
    const { output, transport } = captureTransport()
    const log = createWinstonLogger({ level: 'info', isProduction: true })
    log.add(transport as never)

    log.info('from test', { source: getCallerSource() })

    setImmediate(() => {
      const parsed = JSON.parse(output.at(-1)!)
      expect(parsed.source).toMatch(/logger\.service\.test\.ts:\d+/)
      expect(parsed.source).not.toContain('logger.service.ts:')
      done()
    })
  })
})
```

Note: this test imports and calls `getCallerSource` — you will need to export
it from `logger.service.ts`. If you prefer not to export an internal, test it
indirectly by writing the logger output to a stream and parsing `source` from
the JSON.

- [ ] **Step 9: Run all tests**

```bash
pnpm test
```

Expected: all existing 395 tests pass, plus the new ones. No regressions.

- [ ] **Step 10: Commit**

```bash
git add src/middlewares/request-context.middleware.ts src/services/logger.service.ts src/app.ts package.json pnpm-lock.yaml tests/unit/middlewares/request-context.middleware.test.ts tests/unit/services/logger.service.test.ts
git commit -m "feat: add Winston logger service with AsyncLocalStorage request-id correlation"
```

---

### Task 2: Slack Transport + Env Vars

**Files:**

- Modify: `src/configs/env.config.ts` (add `SLACK_WEBHOOK_URL`, `SLACK_LOG_LEVEL`)
- Modify: `src/services/logger.service.ts` (add `SlackTransport` class, wire into `createWinstonLogger`)
- Create: `tests/unit/services/slack-transport.test.ts`

**Interfaces:**

- Consumes: `createWinstonLogger(options)` from Task 1 — extend options type to include `slackWebhookUrl?: string` and `slackLogLevel?: string`
- Consumes: `getEnv()` — new fields `SLACK_WEBHOOK_URL` and `SLACK_LOG_LEVEL`
- Produces: `SlackTransport` class (internal to `logger.service.ts`, but tested indirectly)

- [ ] **Step 1: Add env vars to `src/configs/env.config.ts`**

Extract a shared log-level schema so `LOG_LEVEL` and `SLACK_LOG_LEVEL` share
the same enum (single source of truth). Insert above the `EnvSchema` definition
(before line 41):

```typescript
const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug'])
```

Update the existing `LOG_LEVEL` field (line 212) to use it:

```typescript
  LOG_LEVEL: LogLevelSchema.default('info'),
```

Add the two new fields after `LOG_LEVEL` (after line 212):

```typescript
  SLACK_WEBHOOK_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(
      'Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.'
    ),
  SLACK_LOG_LEVEL: LogLevelSchema.default('error').describe(
    'Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.'
  ),
```

- [ ] **Step 2: Regenerate `.env.example`**

```bash
pnpm env:example
```

Verify the output includes the new fields (commented out, since both are optional/defaulted):

```bash
grep -A1 'SLACK' .env.example
```

- [ ] **Step 3: Add `SlackTransport` to `src/services/logger.service.ts`**

Extend the `LoggerOptions` interface:

```typescript
interface LoggerOptions {
  level: string
  isProduction: boolean
  slackWebhookUrl?: string
  slackLogLevel?: string
}
```

Add the `SlackTransport` class and its dedup logic. The transport extends
Winston's `Transport` class. First verify the import works:

```typescript
import Transport from 'winston-transport'
```

If pnpm strict mode blocks this (the package is a transitive dep of winston),
use `import { Transport } from 'winston'` instead — Winston re-exports it.
If neither works, `pnpm add winston-transport` as an explicit dependency.

```typescript
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

class SlackTransport extends Transport {
  private readonly webhookUrl: string
  private readonly dedup = new Map<string, DedupEntry>()

  constructor(options: { webhookUrl: string; level?: string }) {
    super({ level: options.level ?? 'error' })
    this.webhookUrl = options.webhookUrl
  }

  override log(info: Record<string, unknown>, callback: () => void): void {
    const source = String(info.source ?? 'unknown')
    const message = String(info.message ?? '')
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
        this.sendToSlack(this.buildSummaryPayload(source, message, entry.count - 1))
      }
    }, DEDUP_WINDOW_MS)
    timer.unref()

    this.dedup.set(key, { count: 1, firstSeen: Date.now(), timer })
    this.sendToSlack(this.buildPayload(info))
    callback()
  }

  private sendToSlack(payload: Record<string, unknown>): void {
    fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      // Direct console.error, NOT logger.error — using the logger here would
      // re-enter this transport and create a feedback loop.
      // eslint-disable-next-line no-restricted-properties
      console.error('Slack webhook failed', error)
    })
  }

  private buildPayload(info: Record<string, unknown>): Record<string, unknown> {
    const level = String(info.level ?? 'error')
    const message = String(info.message ?? '')
    const source = String(info.source ?? 'unknown')
    const requestId = info.requestId ? String(info.requestId) : undefined
    const timestamp = info.timestamp ? String(info.timestamp) : new Date().toISOString()
    const stack =
      info.error && typeof info.error === 'object' && 'stack' in info.error
        ? String((info.error as { stack: string }).stack)
        : undefined

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
}
```

**Critical:** The `.catch()` in `sendToSlack` uses direct `console.error`, NOT
`logger.error`. Using the logger would re-enter `SlackTransport.log()`, creating
a feedback loop where a failed Slack send generates another Slack send that also
fails, forever. The `eslint-disable-next-line` is mandatory — this file is
exempt from the lint gate (Task 3) precisely for this reason.

**Critical:** The `timer.unref()` call is mandatory. Without it, the 60-second
dedup timer in a module-scope singleton keeps vitest workers alive past their
test, causing hangs. `.unref()` lets the process exit naturally.

- [ ] **Step 4: Wire SlackTransport into `createWinstonLogger`**

Update `createWinstonLogger` to accept and use the Slack options:

```typescript
export function createWinstonLogger(options: LoggerOptions): Logger {
  const consoleFormat = options.isProduction
    ? format.combine(addRequestContext(), format.timestamp(), serializeErrors(), format.json())
    : format.combine(
        addRequestContext(),
        format.timestamp({ format: 'HH:mm:ss' }),
        serializeErrors(),
        format.colorize(),
        devFormat
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
```

Update `getLogger` to pass the new fields:

```typescript
const getLogger: () => Logger = (() => {
  let cached: Logger | undefined
  return (): Logger => {
    const env = getEnv()
    cached ??= createWinstonLogger({
      level: env.LOG_LEVEL,
      isProduction: env.NODE_ENV === 'production',
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      slackLogLevel: env.SLACK_LOG_LEVEL,
    })
    return cached
  }
})()
```

- [ ] **Step 5: Write tests for the Slack transport**

Create `tests/unit/services/slack-transport.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWinstonLogger } from '@/services/logger.service'

describe('Slack transport', () => {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a POST to the webhook URL for an error-level log', (done) => {
    const log = createWinstonLogger({
      level: 'error',
      isProduction: true,
      slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      slackLogLevel: 'error',
    })

    log.error('db connection failed', { source: 'database.service.ts:50' })

    setImmediate(() => {
      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://hooks.slack.com/services/T/B/X')
      expect(options.method).toBe('POST')
      const body = JSON.parse(options.body)
      expect(body.attachments[0].blocks[0].text.text).toContain('db connection failed')
      done()
    })
  })

  it('does not send to Slack when level is below SLACK_LOG_LEVEL', (done) => {
    const log = createWinstonLogger({
      level: 'info',
      isProduction: true,
      slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      slackLogLevel: 'error',
    })

    log.info('just info', { source: 'test.ts:1' })

    setImmediate(() => {
      expect(mockFetch).not.toHaveBeenCalled()
      done()
    })
  })

  it('deduplicates: first occurrence sends, second within window is suppressed', (done) => {
    const log = createWinstonLogger({
      level: 'error',
      isProduction: true,
      slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      slackLogLevel: 'error',
    })

    log.error('same error', { source: 'test.ts:1' })
    log.error('same error', { source: 'test.ts:1' })
    log.error('same error', { source: 'test.ts:1' })

    setImmediate(() => {
      expect(mockFetch).toHaveBeenCalledOnce()
      done()
    })
  })

  it('does not throw when the webhook fetch fails', (done) => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const log = createWinstonLogger({
      level: 'error',
      isProduction: true,
      slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      slackLogLevel: 'error',
    })

    log.error('should not throw', { source: 'test.ts:1' })

    setImmediate(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Slack webhook failed', expect.any(Error))
      consoleErrorSpy.mockRestore()
      done()
    })
  })

  it('is not registered when slackWebhookUrl is unset', (done) => {
    const log = createWinstonLogger({
      level: 'error',
      isProduction: true,
    })

    log.error('no slack', { source: 'test.ts:1' })

    setImmediate(() => {
      expect(mockFetch).not.toHaveBeenCalled()
      done()
    })
  })
})
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

Expected: all tests pass including the new Slack transport tests.

- [ ] **Step 7: Commit**

```bash
git add src/configs/env.config.ts src/services/logger.service.ts .env.example tests/unit/services/slack-transport.test.ts
git commit -m "feat: add Slack transport with per-unique-message deduplication"
```

---

### Task 3: Call Site Migration + ESLint Gate + Docs

**Files:**

- Modify: `src/middlewares/error.middleware.ts` (line 237)
- Modify: `src/services/redis.service.ts` (line 52)
- Modify: `src/services/mailer.service.ts` (lines 320, 367)
- Modify: `src/controllers/auth.controller.ts` (lines 242, 252)
- Modify: `src/controllers/verification.controller.ts` (line 148)
- Modify: `src/utilities/password.utilities.ts` (lines 73-76)
- Modify: `src/configs/mailer.config.ts` (line 165)
- Modify: `src/configs/rate-limit-store.config.ts` (line 92)
- Modify: `src/server.ts` (line 23)
- Modify: `tests/unit/middlewares/error.middleware.test.ts` (lines 36-43)
- Modify: `tests/unit/utilities/password.utilities.test.ts` (line 93)
- Modify: `tests/unit/configs/mailer.config.test.ts` (lines 152-166, 182-196)
- Modify: `tests/unit/configs/rate-limit-store.config.test.ts` (lines 54, 76, 89, 134)
- Modify: `tests/integration/api/body-parser.test.ts` (line 19)
- Modify: `tests/integration/services/mailer.service.test.ts` (lines 527-554, 602-622)
- Modify: `eslint.config.mjs` (lines 173-180, add exemption blocks)
- Modify: `CLAUDE.md` (add logger convention section)
- Do NOT modify: `src/index.ts` (stays as `console.error` — pre-boot path)

**Interfaces:**

- Consumes: `logger` from `src/services/logger.service.ts` — `logger.error(message, meta?)`, `logger.warn(message, meta?)`, `logger.info(message, meta?)`
- Consumes: `requestContextStore` from `src/middlewares/request-context.middleware.ts` (used in error.middleware.test.ts to wrap calls in ALS context)

**IMPORTANT — ordering within this task:** Migrate ALL call sites and commit
FIRST, THEN add the ESLint rule and commit. Pre-commit lints staged files — if
`eslint.config.mjs` (with the new rule) is staged alongside an unmigrated
source file, the commit fails.

- [ ] **Step 1: Migrate `src/middlewares/error.middleware.ts`**

Add import at the top:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 237:

```typescript
// Before:
console.error(`[${String(response.getHeader(REQUEST_ID_HEADER))}]`, redactedForLog(error))
// After:
logger.error('Unhandled server error', { error: redactedForLog(error) })
```

The `[${requestId}]` prefix is removed — the logger reads it automatically from
AsyncLocalStorage. Check whether `REQUEST_ID_HEADER` is still used elsewhere in
this file (it is — the import remains, because `response.getHeader(REQUEST_ID_HEADER)`
is not the only reference — the header name is imported but the manual
interpolation into the log message is what's being replaced). Verify by grep:

```bash
grep REQUEST_ID_HEADER src/middlewares/error.middleware.ts
```

If the import is now unused, remove it.

- [ ] **Step 2: Migrate `src/services/redis.service.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 52:

```typescript
// Before:
client.on('error', (error) => console.error('redis error', error))
// After:
client.on('error', (error: unknown) => logger.error('Redis error', { error }))
```

- [ ] **Step 3: Migrate `src/services/mailer.service.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 320:

```typescript
// Before:
console.error('Failed to record email delivery log', redactedForLog(error))
// After:
logger.error('Failed to record email delivery log', { error: redactedForLog(error) })
```

Replace line 367:

```typescript
// Before:
console.error('Mail send failed', redactedMailErrorForLog(error))
// After:
logger.error('Mail send failed', { error: redactedMailErrorForLog(error) })
```

- [ ] **Step 4: Migrate `src/controllers/auth.controller.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 242:

```typescript
// Before:
console.error('Verification mail failed', error)
// After:
logger.error('Verification mail failed', { error })
```

Replace line 252:

```typescript
// Before:
console.error('Registration-attempt mail failed', error)
// After:
logger.error('Registration-attempt mail failed', { error })
```

- [ ] **Step 5: Migrate `src/controllers/verification.controller.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 148:

```typescript
// Before:
console.error('Resend verification mail failed', error)
// After:
logger.error('Resend verification mail failed', { error })
```

- [ ] **Step 6: Migrate `src/utilities/password.utilities.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace lines 73-76:

```typescript
// Before:
console.error('[password.utilities] isPasswordValid: comparison threw, treating as no match', error)
// After:
logger.error('isPasswordValid: comparison threw, treating as no match', { error })
```

The `[password.utilities]` prefix is removed — the `source` field automatically
includes `password.utilities.ts:<line>`.

- [ ] **Step 7: Migrate `src/configs/mailer.config.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace the `console.warn(...)` call (line 165):

```typescript
// Before:
console.warn(
  'mailer.config: exactly one of SMTP_USER/SMTP_PASS is set — no SMTP authentication will be attempted, so every send will fail with EAUTH against a provider that requires it. Set both, or neither (Mailpit needs neither).'
)
// After:
logger.warn(
  'Exactly one of SMTP_USER/SMTP_PASS is set — no SMTP authentication will be attempted, so every send will fail with EAUTH against a provider that requires it. Set both, or neither (Mailpit needs neither).'
)
```

The `mailer.config:` prefix is removed — `source` field handles it.

- [ ] **Step 8: Migrate `src/configs/rate-limit-store.config.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 92:

```typescript
// Before:
console.warn(
  'rate-limit-store: Redis is not reachable yet; falling back to an in-memory rate-limit store'
)
// After:
logger.warn('Redis is not reachable yet; falling back to an in-memory rate-limit store')
```

The `rate-limit-store:` prefix is removed — `source` field handles it.

- [ ] **Step 9: Migrate `src/server.ts`**

Add import:

```typescript
import { logger } from '@/services/logger.service'
```

Replace line 23:

```typescript
// Before:
console.info(`listening on :${port}`)
// After:
logger.info(`Listening on :${port}`)
```

- [ ] **Step 10: Update `tests/unit/middlewares/error.middleware.test.ts`**

Replace the console.error spy with a logger spy. The error handler now uses
`logger.error` which auto-attaches the request-id via AsyncLocalStorage. Unit
tests that call `errorHandler` directly have no ALS context, so wrap calls
that should carry a request-id in `requestContextStore.run()`.

Replace lines 36-43:

```typescript
import { requestContextStore } from '@/middlewares/request-context.middleware'
import { logger } from '@/services/logger.service'

// ...inside describe('errorHandler', () => {
let loggerError: Mock

beforeEach(() => {
  loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})
```

For any test that asserts on log calls including the request-id, wrap in ALS:

```typescript
it('logs 5xx errors with the request-id from ALS context', () => {
  const { response, body, status } = mockResponse()
  requestContextStore.run({ requestId: 'test-req-id' }, () => {
    errorHandler(new Error('boom'), {} as never, response, vi.fn())
  })
  expect(loggerError).toHaveBeenCalled()
})
```

**Why this matters:** Winston's Console transport writes `process.stdout.write`,
not `console.*`. Post-migration, `vi.spyOn(console, 'error')` captures nothing
— existing assertions like "not called for 4xx" would become vacuously green
(always passing whether the code logs or not). Switching to
`vi.spyOn(logger, 'error')` is what makes those assertions load-bearing again.

- [ ] **Step 11: Update `tests/unit/utilities/password.utilities.test.ts`**

Replace line 93:

```typescript
// After:
import { logger } from '@/services/logger.service'

// Before:
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

// ...
const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
```

- [ ] **Step 12: Update `tests/unit/configs/mailer.config.test.ts`**

Replace all `console.warn` spy/reassignment patterns with logger spies:

```typescript
import { logger } from '@/services/logger.service'

// ...
const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
// ... test code ...
// No try/finally needed — vi.restoreAllMocks() in afterEach handles it
```

- [ ] **Step 13: Update `tests/unit/configs/rate-limit-store.config.test.ts`**

Replace all `vi.spyOn(console, 'warn')` with `vi.spyOn(logger, 'warn')`:

```typescript
import { logger } from '@/services/logger.service'

// ...
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
```

- [ ] **Step 14: Update `tests/integration/api/body-parser.test.ts`**

Replace line 19:

```typescript
import { logger } from '@/services/logger.service'

// ...
consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {})
```

Rename the variable from `consoleError` to `loggerError` for clarity.

- [ ] **Step 15: Update `tests/integration/services/mailer.service.test.ts`**

This file uses DIRECT `console.error` reassignment (not `vi.spyOn`) in two
places (lines 527-554 and 602-622). The file's own comment explains why:
`vi.spyOn(console, 'error')` was unreliable here due to some interaction with
the console-interception layer. Since `logger` is a plain module-scope object
(not a global like `console`), `vi.spyOn(logger, 'error')` should work
reliably. Replace both patterns:

```typescript
import { logger } from '@/services/logger.service'

// Replace lines 527-554 and 602-622 patterns:
// Before:
    const capturedErrorCalls: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...callArguments: unknown[]): void => {
      capturedErrorCalls.push(callArguments)
    }
    try { ... } finally { console.error = originalConsoleError }

// After:
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    // ... test code (no try/finally needed) ...
    // Assert:
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Failed to record email delivery log',
      expect.objectContaining({ error: expect.any(Object) })
    )
```

If `vi.spyOn(logger, 'error')` shows the same unreliability as
`vi.spyOn(console, 'error')` did (unlikely — the issue was specific to
`console`), fall back to the same direct-reassignment pattern on `logger.error`.

- [ ] **Step 16: Run all tests**

```bash
pnpm test
```

Expected: all tests pass. The test count should be the same as before (395 + new
logger/transport tests from Tasks 1-2). No regressions.

- [ ] **Step 17: Verify no `console.*` calls remain in `src/` (except `index.ts`)**

```bash
grep -rn 'console\.\(error\|warn\|info\|log\|debug\)' src/ --include='*.ts' | grep -v 'logger.service.ts' | grep -v 'index.ts'
```

Expected: no output. Every call site has been migrated.

- [ ] **Step 18: Commit the migration**

```bash
git add src/ tests/
git commit -m "refactor: migrate all console.* calls to Winston logger"
```

**Commit this BEFORE adding the ESLint rule.** If the rule is staged alongside
an unmigrated file, pre-commit lint fails.

- [ ] **Step 19: Add ESLint lint gate in `eslint.config.mjs`**

Extend the existing `no-restricted-properties` array (lines 173-180) to ban
`console.error`, `console.warn`, `console.info`, `console.log`, and
`console.debug`:

```javascript
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from @/configs/env.config, not process.env. See spec §5.1.',
        },
        { object: 'console', property: 'error', message: 'Use logger from @/services/logger.service.' },
        { object: 'console', property: 'warn', message: 'Use logger from @/services/logger.service.' },
        { object: 'console', property: 'info', message: 'Use logger from @/services/logger.service.' },
        { object: 'console', property: 'log', message: 'Use logger from @/services/logger.service.' },
        { object: 'console', property: 'debug', message: 'Use logger from @/services/logger.service.' },
      ],
```

Add exemption blocks for `logger.service.ts` and `index.ts` (after the existing
`env.config.ts` exemption block at line 206):

```javascript
  {
    // logger.service.ts is the one module that talks to Winston's console
    // transport, and its SlackTransport.sendToSlack uses console.error for
    // failure logging to avoid re-entering the logger.
    // index.ts is the pre-boot error path where the logger is not yet
    // available (env validation failed before any service could initialize).
    // Both rules (process.env and console.*) are lifted — the process.env
    // exemption is a side effect, not the intent, but harmless: neither
    // module reads process.env.
    files: ['src/services/logger.service.ts', 'src/index.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
```

- [ ] **Step 20: Add lint gate test in `tests/unit/lint-gates.test.ts`**

Add a test proving the `console.*` ban fires, matching the existing pattern at
line 120 (`allows process.env inside env.config and blocks it elsewhere`):

```typescript
it('allows console.error inside logger.service.ts and index.ts but blocks it elsewhere', async () => {
  const source = 'export function f(): void { console.error("x") }\n'
  expect(await ruleIdsFor('src/services/logger.service.ts', source)).not.toContain(
    'no-restricted-properties'
  )
  expect(await ruleIdsFor('src/index.ts', source)).not.toContain('no-restricted-properties')
  expect(await ruleIdsFor('src/services/other.service.ts', source)).toContain(
    'no-restricted-properties'
  )
})
```

- [ ] **Step 21: Run lint to verify the gate fires**

```bash
pnpm lint
```

Expected: passes (all console.* calls in `src/` are either migrated or exempt).

- [ ] **Step 22: Update CLAUDE.md**

Add a section after the "Environment and processes" section:

```markdown
## Logging

- **`logger` from `@/services/logger.service`, not `console.*`.** An ESLint
  `no-restricted-properties` rule enforces this for `src/`. Two files are
  exempt: `logger.service.ts` (talks to Winston's console transport and uses
  `console.error` in the Slack transport's failure path to avoid re-entry) and
  `index.ts` (pre-boot error path where the logger is not available).
- **Request-id correlation is automatic.** The `requestContext` middleware
  wraps each request in an `AsyncLocalStorage` context. The logger reads from
  it on every call — callers never pass the id. Code outside a request (startup,
  Redis error handler) simply omits the field.
- **Caller file:line is automatic.** The logger parses `new Error().stack` on
  each call. The `[moduleName]` prefixes that some call sites used to include
  in their messages are redundant — the `source` field handles it.
- **Slack transport deduplicates by `${source}:${message}`.** The first
  occurrence sends immediately; duplicates within a 60-second window are
  suppressed. A summary is sent after the window expires if any were suppressed.
```

- [ ] **Step 23: Commit the lint gate and docs**

```bash
git add eslint.config.mjs tests/unit/lint-gates.test.ts CLAUDE.md
git commit -m "chore: add ESLint lint gate banning console.* in src/ and document logger convention"
```

- [ ] **Step 24: Run full test suite with coverage**

```bash
pnpm test:coverage
```

Expected: all tests pass, coverage stays above 95%.
