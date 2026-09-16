# Winston Structured Logging — Design Spec

Status: approved in brainstorming
Session: https://claude.ai/code/session_018W6fi5MwVob2Vr1AexY5Mu
Date: 2026-09-16
Stream: 1 of 7 (see `2026-09-16-boilerplate-roadmap.md`)

## Problem

The codebase uses `console.error` / `console.warn` / `console.info` directly
across 15 call sites in 8 files. This has three problems:

1. **No structure.** Production logs are unstructured text — searching for a
   failed request means grepping for a substring, not querying a field.
2. **No automatic correlation.** The error middleware manually interpolates
   `[${requestId}]` into the message. Every other call site (controllers,
   services) omits it entirely — an error in `mailer.service.ts` is
   unconnectable to the request that caused it.
3. **No alerting.** Errors write to stdout and vanish. There is no path from
   "something broke" to "someone knows about it" without a human tailing logs.

Both Ofluence/core and Consequential/core use Winston with the same pattern
this design follows.

## Solution

A Winston logger service with:

- JSON output in production, human-readable colorized output in development
- Automatic request-id correlation via `AsyncLocalStorage`
- Automatic caller file:line on every log entry
- Slack webhook transport for error alerting with per-unique-message deduplication
- An ESLint lint gate banning `console.*` in `src/` (same pattern as the
  existing `process.env` gate)

## 1. Logger Service

**File:** `src/services/logger.service.ts`

### Public API

```typescript
import { logger } from '@/services/logger.service'

logger.error('Mail send failed', { error: redactedForLog(error) })
logger.warn('Redis not reachable, falling back to in-memory store')
logger.info('Listening on :3000')
logger.debug('Token claims', { sub, exp })
```

Every call automatically attaches:

| Field       | Source                          | Example                    |
| ----------- | ------------------------------- | -------------------------- |
| `timestamp` | Winston built-in                | `2026-09-16T12:00:00.000Z` |
| `level`     | Winston built-in                | `error`                    |
| `message`   | First argument                  | `Mail send failed`         |
| `source`    | Parsed from `new Error().stack` | `mailer.service.ts:367`    |
| `requestId` | Read from `AsyncLocalStorage`   | `a1b2c3d4-e5f6-...`        |

The `source` field is stripped to repo-relative paths (no absolute
`/Users/.../src/...`). The `requestId` is only present when the log call
happens inside a request context — startup-time logs omit it naturally.

### Transports

**Console transport (always active):**

- **Production** (`NODE_ENV=production`): JSON, one line per entry to stdout.
  ```json
  {
    "level": "error",
    "message": "Mail send failed",
    "requestId": "a1b2c3d4-...",
    "source": "mailer.service.ts:367",
    "timestamp": "2026-09-16T12:00:00.000Z",
    "errorCode": "ECONNREFUSED"
  }
  ```
- **Development** (all other `NODE_ENV`): colorized, human-readable to stdout.
  ```
  12:00:00 ERROR [mailer.service.ts:367] (a1b2c3d4) Mail send failed
  ```
  Time without date (you know what day it is locally). Request-id shortened.
  Error stacks printed below, indented. No JSON clutter — if you need
  structured fields, set `NODE_ENV=production` locally.

Everything goes to stdout (not split stderr/stdout). Every container log
collector merges them anyway; splitting complicates the config for no gain.

**Log level:** read from the existing `LOG_LEVEL` env var (already in the
schema as `z.enum(['error', 'warn', 'info', 'debug']).default('info')`).

### Lazy Initialization

Same pattern as every other service in this codebase: the logger is created on
first use, not at module scope. It reads `getEnv()` for `LOG_LEVEL`,
`NODE_ENV`, `SLACK_WEBHOOK_URL`, and `SLACK_LOG_LEVEL`. A module-scope
construction would crash during import resolution if the env is invalid —
exactly the failure mode `getEnv()`'s lazy design exists to prevent (see
CLAUDE.md).

### Caller Location Extraction

On each log call, capture `new Error().stack` and parse the first frame
external to `logger.service.ts` to extract `filename:line`. The performance
cost is ~1μs per call — negligible vs any I/O the log entry triggers.

The path is stripped to repo-relative: `src/services/mailer.service.ts:367`,
not `/Users/abhijeet/Mahaverick/express-boilerplate/src/services/mailer.service.ts:367`.

## 2. Request Context (AsyncLocalStorage)

**File:** `src/middlewares/request-context.middleware.ts`

An `AsyncLocalStorage<{ requestId: string }>` store. The middleware runs
immediately after `requestId` in the middleware chain (registered in
`src/app.ts`):

```typescript
app.use(requestId)
app.use(requestContext) // new — wraps the rest of the request in ALS
```

The logger reads from this store on every call. Callers never pass the
request-id — it is always automatic. Code running outside a request (startup,
Redis error handler, graceful shutdown) simply has no context in the store, and
the `requestId` field is omitted from the log entry.

This same `AsyncLocalStorage` context is what Stream 3 (OpenTelemetry) will
read from when wiring trace-id correlation — building it now avoids retrofitting
later.

## 3. Slack Transport

### Configuration

Two new env vars in `env.config.ts`:

- `SLACK_WEBHOOK_URL` — `z.string().url().optional()`. When unset, no Slack
  transport is registered. No Slack in dev/test by default.
- `SLACK_LOG_LEVEL` — `z.enum(['error', 'warn', 'info', 'debug']).default('error')`.
  Only logs at or above this level go to Slack. Defaults to `error` but
  configurable for derived projects that want warn-level Slack alerts.

### Custom Transport

A custom Winston transport (~40 lines), not an npm package. The entire
implementation is a `fetch()` POST to the webhook URL with a Block Kit payload.
An npm package for a single HTTP POST adds a dependency for no value.

### Message Format (Block Kit)

- Color-coded sidebar: red for error, yellow for warn, blue for info
- Header: level emoji + message
- Fields section: source file:line, request-id (when present), timestamp
- Collapsed stack trace (when present)

### Deduplication

Without rate limiting, a database outage sends hundreds of identical Slack
messages in seconds.

- **Key:** `${source}:${message}` (file:line + message text)
- **Window:** 60 seconds
- **Behavior:** the first occurrence sends immediately. Duplicates within the
  window are counted but suppressed. After the window expires, if any were
  suppressed, a summary message is sent: "Suppressed N duplicate occurrences
  of [message] from [source] in the last 60s"
- **Implementation:** in-memory `Map<string, { count: number; firstSeen: number }>`.
  No Redis dependency — the logger must work before Redis is connected.
  Entries are cleaned up lazily (checked on each log call, expired entries
  removed).

### Failure Handling

If the webhook `fetch()` fails (network error, Slack outage, invalid URL), the
failure is logged locally to the console transport. The Slack transport never
retries, never throws, never rejects — it must not break the application or
create a feedback loop of error logs about failed error logs.

## 4. Call Site Migration

15 call sites across 8 files. Each `console.*` becomes a `logger.*` call.

| File                         | Count | Current                                                                                                                             | After                                                                                | Notes                                                             |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `error.middleware.ts`        | 1     | `console.error(\`[\${requestId}]\`, redactedForLog(error))`                                                                         | `logger.error(message, { error: redactedForLog(error) })`                            | Request-id prefix removed — automatic via ALS                     |
| `redis.service.ts`           | 1     | `console.error('redis error', error)`                                                                                               | `logger.error('Redis error', { error })`                                             | Outside request context, no request-id — correct                  |
| `mailer.service.ts`          | 2     | `console.error('Failed to record...', redactedForLog(error))` / `console.error('Mail send failed', redactedMailErrorForLog(error))` | `logger.error(...)`                                                                  | Redaction utilities unchanged                                     |
| `auth.controller.ts`         | 2     | `console.error('Verification mail failed', error)` / `console.error('Registration-attempt mail failed', error)`                     | `logger.error(...)`                                                                  | Inside request context — gets request-id                          |
| `verification.controller.ts` | 1     | `console.error('Resend verification mail failed', error)`                                                                           | `logger.error(...)`                                                                  | Same pattern                                                      |
| `password.utilities.ts`      | 1     | `console.error('[password.utilities] isPasswordValid...', error)`                                                                   | `logger.error('isPasswordValid: comparison threw, treating as no match', { error })` | `[password.utilities]` prefix removed — `source` field handles it |
| `mailer.config.ts`           | 1     | `console.warn('...SMTP_USER/SMTP_PASS...')`                                                                                         | `logger.warn(...)`                                                                   | Startup-time, no request context                                  |
| `rate-limit-store.config.ts` | 1     | `console.warn('...Redis not reachable...')`                                                                                         | `logger.warn(...)`                                                                   | Startup-time, no request context                                  |
| `server.ts`                  | 1     | `console.info(\`listening on :${port}\`)`                                                                                           | `logger.info(...)`                                                                   | Boot message                                                      |
| `index.ts`                   | 1     | `console.error((error as Error).message)`                                                                                           | **STAYS AS `console.error`**                                                         | Pre-boot path: env validation failed, logger is not available     |

**Existing utilities are unchanged:**

- `redactedForLog()` stays in `error.middleware.ts` — exported, used by both the
  error handler and `mailer.service.ts`
- `redactedMailErrorForLog()` stays in `mailer.service.ts`

The logger calls these utilities the same way the `console.error` calls do
today. The logger does not own redaction — it logs what it is given.

## 5. ESLint Lint Gate

After migration, ban `console.*` in `src/` so future code is forced through the
logger. Same pattern as the existing `process.env` → `env.config.ts` gate.

**Rule:** extend the existing `no-restricted-properties` array in
`eslint.config.mjs` to also ban `console.error`, `console.warn`, `console.info`,
`console.log`, and `console.debug`:

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

This uses the same `no-restricted-properties` rule already in place for
`process.env`, targeting specific methods rather than the `console` global
itself — so a local variable named `console` (unlikely but legal) is unaffected.

**Exemptions** (separate config blocks with `no-restricted-properties: 'off'`):

- `src/services/logger.service.ts` — the one module that talks to Winston's
  console transport
- `src/index.ts` — pre-boot error path where the logger cannot exist yet
- `src/configs/env.config.ts` — already exempted (for `process.env`); now also
  covers the console ban

This mirrors the `process.env` exemption pattern exactly.

## 6. Test Migration

Tests that spy on `console.error` / `console.warn` switch to spying on the
logger:

```typescript
// After
import { logger } from '@/services/logger.service'

// Before
const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
```

Affected test files (~8):

- `error.middleware.test.ts`
- `password.utilities.test.ts`
- `mailer.config.test.ts`
- `rate-limit-store.config.test.ts`
- `body-parser.test.ts`
- `mailer.service.test.ts`
- Any other test asserting on log output

The logger is exported as a named singleton, so `vi.spyOn` reaches the same
instance every caller uses.

## 7. File Structure

**New files:**

| File                                            | Purpose                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `src/services/logger.service.ts`                | Winston logger, transports, caller-location extraction, Slack dedup |
| `src/middlewares/request-context.middleware.ts` | AsyncLocalStorage store + middleware                                |

**Modified files:**

| File                        | Change                                                    |
| --------------------------- | --------------------------------------------------------- |
| `src/configs/env.config.ts` | Add `SLACK_WEBHOOK_URL`, `SLACK_LOG_LEVEL`                |
| `src/app.ts`                | Register `requestContext` middleware after `requestId`    |
| `eslint.config.mjs`         | Add `no-restricted-globals` for `console` with exemptions |
| 8 source files              | `console.*` → `logger.*` (15 call sites)                  |
| ~8 test files               | `vi.spyOn(console, ...)` → `vi.spyOn(logger, ...)`        |
| `.env.example`              | Add `SLACK_WEBHOOK_URL`, `SLACK_LOG_LEVEL`                |
| `CLAUDE.md`                 | Document the logger convention and lint gate              |

**New dependency:**

- `winston` — the only new package. No `winston-slack-webhook-transport`.
  Winston ships its own types — no `@types/winston`.

## 8. What This Does NOT Include

- **Log file rotation** — stdout only, the deployment collects it
- **Child loggers / namespaces** — YAGNI for a boilerplate
- **Log sampling** — every entry is logged; sampling is an OTEL concern (Stream 3)
- **Sentry / error tracking integration** — a separate transport, not part of
  structured logging
- **Morgan HTTP access logs** — a separate concern; this is application logging
