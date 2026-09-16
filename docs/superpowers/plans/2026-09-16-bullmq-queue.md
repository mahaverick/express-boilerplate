# BullMQ Job Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fire-and-forget email pattern with a BullMQ job queue backed by Redis, adding retry with exponential backoff, priority levels, graceful shutdown, health check integration, and multi-pod support.

**Architecture:** A lazy-initialized queue service creates BullMQ `Queue` and `Worker` instances using `ioredis` connected to the existing `REDIS_URL`. Email helpers (`sendVerificationMail`, `sendRegistrationAttemptMail`, `resendVerificationMail`) switch their internal `sendMail()` call to `addEmailJob()`. Controllers remain unchanged — they still call the same helpers with the same `.catch()` pattern. `sendMail()` returns `'sent' | 'failed'` so the worker can decide whether BullMQ should retry.

**Tech Stack:** BullMQ 5.x, ioredis (explicit dependency), Zod 4 for env validation.

**Spec:** `docs/superpowers/specs/2026-09-16-bullmq-queue-design.md`

## Global Constraints

- TypeScript pinned `~6.0.3` — do not upgrade (see MIGRATIONS.md)
- Zod 4.6.5 — use `z.stringbool()` for boolean env vars (NOT `z.coerce.boolean()` — `Boolean("false") === true`)
- No barrel files — import directly
- `getEnv()` is lazy and memoised — new services MUST follow the same lazy init pattern
- File naming: `src/services/*.service.ts`, `src/middlewares/*.middleware.ts`, plus new conventions for `src/jobs/*.job.ts` and `src/workers/*.worker.ts`
- `pnpm env:example` regenerates `.env.example` — never hand-edit it
- Pre-commit runs `eslint` + `vitest --changed HEAD` (excluding `tests/integration/**`); pre-push runs `pnpm lint` + `pnpm test:coverage`
- Tests that hit Docker (database, Redis, Mailpit, BullMQ) MUST live under `tests/integration/`, never `tests/unit/`
- Each vitest worker gets its own database via `VITEST_POOL_ID` — queue prefixes must follow the same pattern to avoid cross-worker job leaks
- `MailMessage` is a discriminated union on `templateKey` — never bypass it with `as MailMessage` or `Record<string, string>`
- `sendMail()` never rejects (Ruling G) — the worker's retry decision comes from the return value, not from catching a rejection

## Spec Corrections (rulings against the spec)

The following spec sections contain incorrect exact-values. The plan text below has the corrected values; implementers follow the plan, not the spec, for these items.

1. **Spec §5:** `z.coerce.boolean().default(true)` is wrong — `Boolean("false") === true`. Use `z.stringbool().default(true)`.
2. **Spec §3 `EmailJobData`:** `variables: Record<string, string>` + `templateKey: string` breaks the `MailMessage` discriminated union. Use `type EmailJobData = MailMessage & { userId: string }`.
3. **Spec §8:** "sendVerificationMail / resendVerificationMail may become unused" — wrong. The helpers contain load-bearing logic (token issuance, token revocation ordering, stored-name security). Modify the helper BODIES to enqueue instead of calling `sendMail()` directly. Controllers stay unchanged.
4. **Spec §4 error text:** `throw new Error(\`Email send failed for ${templateKey} to ${email}\`)`puts PII (email) in BullMQ's`failedReason`(persisted in Redis). Throw with`jobId`and`templateKey` only.
5. **Spec §3 `removeOnComplete`:** `{ age: 24 * 3600 }` keeps the raw verification token in Redis for 24h. Use `removeOnComplete: true` (delete immediately — `email_logs` is the audit trail). `removeOnFail: { age }` should not exceed `EMAIL_VERIFICATION_TTL`.
6. **Spec §1 connection:** BullMQ's `connection` option takes `RedisOptions` (ioredis), not a URL string. Construct `new IORedis(REDIS_URL)` explicitly. Must set `maxRetriesPerRequest: null` for Worker connections (BullMQ requirement). Must set bounded `retryStrategy` so `isQueueReachable()` doesn't hang (same class as `redis.service.ts`'s `reconnectStrategy` — see CLAUDE.md).
7. **Spec §4 missing events:** `worker.on('error')` and `queue.on('error')` are mandatory — an unlistened `'error'` event crashes the process. The spec only lists `failed`/`completed`.
8. **Spec §7 worker location:** `server.ts` module-level `activeWorker` trips `unicorn/no-top-level-assignment-in-function`, and putting it in `startServer()` makes the lifecycle test open a BullMQ connection. Gate worker startup in `index.ts`'s `boot()` instead. Pass `worker` to `gracefulShutdown(server, worker?)`.
9. **Spec §3 backoff comment:** `// 10s, 20s, 40s, 80s, 160s` is wrong — with `delay: 5000` and 5 attempts there are 4 waits: 5s, 10s, 20s, 40s.
10. **Spec §2 `JobPriority` location:** `email.job.ts` is wrong for a "shared by future job types" const. Put it in `src/constants/queue.constants.ts`.

---

### Task 1: Queue Service + Env Vars + ESLint Conventions

**Files:**

- Create: `src/services/queue.service.ts`
- Create: `src/constants/queue.constants.ts`
- Modify: `src/configs/env.config.ts` (add `WORKER_ENABLED`, `QUEUE_PREFIX`)
- Modify: `eslint.config.mjs` (add `src/jobs/*.job.ts`, `src/workers/*.worker.ts` naming conventions)
- Modify: `package.json` (add `bullmq`, `ioredis`)
- Modify: `tests/helpers/setup-global.ts` (add per-worker queue prefix)
- Create: `tests/unit/services/queue.service.test.ts`
- Create: `tests/integration/services/queue-unreachable.service.test.ts`

**Interfaces:**

- Consumes: `getEnv()` from `@/configs/env.config` — fields `REDIS_URL`, `WORKER_ENABLED`, `QUEUE_PREFIX`
- Produces: `getQueueConnection(): IORedis` — lazy shared ioredis connection
- Produces: `getEmailQueue(): Queue` — lazy email queue instance
- Produces: `addJob<T>(queue, jobName, data, opts?): Promise<Job<T>>` — generic enqueue wrapper
- Produces: `isQueueReachable(): Promise<boolean>` — health check
- Produces: `closeQueue(): Promise<void>` — graceful shutdown
- Produces: `JobPriority` const from `@/constants/queue.constants`

- [ ] **Step 1: Install dependencies**

```bash
pnpm add bullmq ioredis
```

BullMQ 5.x ships its own types. `ioredis` must be explicit — pnpm strict mode won't let you import a transitive dependency. Verify both resolve:

```bash
node -e "import('bullmq').then(b => console.log('Queue:', typeof b.Queue)); import('ioredis').then(i => console.log('IORedis:', typeof i.default))"
```

- [ ] **Step 2: Add env vars to `src/configs/env.config.ts`**

Add after the `LOG_LEVEL` / `SLACK_*` fields:

```typescript
  WORKER_ENABLED: z
    .stringbool()
    .default(true)
    .describe(
      'Whether the BullMQ worker starts in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true.'
    ),
  QUEUE_PREFIX: z
    .string()
    .min(1)
    .default('bull')
    .describe(
      'BullMQ Redis key prefix. Tests override this per vitest worker to prevent cross-worker job leaks.'
    ),
```

**Critical:** use `z.stringbool()`, NOT `z.coerce.boolean()`. `Boolean("false")` is `true` in JavaScript — `z.coerce.boolean()` would make `WORKER_ENABLED=false` enable the worker. `z.stringbool()` (Zod 4) correctly parses `"false"` → `false`.

Write a test immediately to prove this:

```typescript
import { parseEnv } from '@/configs/env.config'

// ... in a test:
const env = parseEnv({ ...validEnv, WORKER_ENABLED: 'false' })
expect(env.WORKER_ENABLED).toBe(false)
```

- [ ] **Step 3: Add per-worker queue prefix to test setup**

In `tests/helpers/setup-global.ts`, after `useWorkerDatabase()`, add:

```typescript
// Per-worker BullMQ prefix — same mechanism as per-worker DATABASE_URL.
// Without this, a Worker started in pool 1 would process pool 2's jobs
// and write email_logs into the wrong database.
const poolId = process.env.VITEST_POOL_ID ?? '0'
process.env.QUEUE_PREFIX = `bull:test-w${poolId}`
```

This mirrors the `useWorkerDatabase()` pattern — each vitest worker gets an isolated queue namespace.

- [ ] **Step 4: Create `src/constants/queue.constants.ts`**

```typescript
export const JobPriority = {
  critical: 1,
  high: 2,
  normal: 5,
  low: 10,
} as const

export type JobPriorityName = keyof typeof JobPriority
```

- [ ] **Step 5: Create `src/services/queue.service.ts`**

```typescript
import { Queue, type Job, type JobsOptions } from 'bullmq'
import IORedis from 'ioredis'
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'

const state: {
  connection: IORedis | undefined
  emailQueue: Queue | undefined
  closed: boolean
} = { connection: undefined, emailQueue: undefined, closed: false }

/**
 * Shared ioredis connection for all BullMQ queues and workers.
 *
 * Separate from redis.service.ts's node-redis client — different libraries,
 * cannot share. BullMQ requires `maxRetriesPerRequest: null` on Worker
 * connections; setting it on the shared connection satisfies both Queue and
 * Worker use.
 */
export function getQueueConnection(): IORedis {
  if (state.closed) {
    throw new Error('Queue connection is closed; the process is shutting down')
  }
  if (!state.connection) {
    state.connection = new IORedis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
      connectTimeout: 5000,
    })
    state.connection.on('error', (error: unknown) => {
      logger.error('BullMQ Redis connection error', { error })
    })
  }
  return state.connection
}

export function getEmailQueue(): Queue {
  if (!state.emailQueue) {
    state.emailQueue = new Queue('email', {
      connection: getQueueConnection(),
      prefix: getEnv().QUEUE_PREFIX,
    })
    state.emailQueue.on('error', (error: unknown) => {
      logger.error('Email queue error', { error })
    })
  }
  return state.emailQueue
}

export async function addJob<T extends object>(
  queue: Queue,
  jobName: string,
  data: T,
  options?: JobsOptions
): Promise<Job<T>> {
  return queue.add(jobName, data, options)
}

export async function isQueueReachable(): Promise<boolean> {
  if (state.closed) return false
  try {
    const connection = getQueueConnection()
    const reply = await connection.ping()
    return reply === 'PONG'
  } catch {
    return false
  }
}

export async function closeQueue(): Promise<void> {
  state.closed = true
  if (state.emailQueue) {
    await state.emailQueue.close()
    state.emailQueue = undefined
  }
  if (state.connection) {
    await state.connection.quit()
    state.connection = undefined
  }
}
```

**Key ioredis options:**

- `maxRetriesPerRequest: null` — BullMQ requirement for Worker connections. Without it, BullMQ throws `"You are using a non-supported version of Redis"`.
- `retryStrategy: (times) => times > 3 ? null : ...` — bounded retries so `isQueueReachable()` returns `false` within seconds, not hangs forever. Mirrors `redis.service.ts`'s own `reconnectStrategy`.
- `connectTimeout: 5000` — same 5s budget as `redis.service.ts`.
- `queue.on('error', ...)` — mandatory. An unlistened `'error'` event crashes the Node.js process.

**Note on `enableOfflineQueue`:** ioredis defaults to `true`, which buffers `queue.add()` calls when Redis is unreachable and replays them when it reconnects — `queue.add()` never rejects. This is actually the right behavior for a queue: if Redis blips for 2 seconds, enqueued jobs survive the blip. The controller's `.catch()` handles the case where ioredis gives up entirely (after `retryStrategy` returns `null`). Do NOT set `enableOfflineQueue: false` — it would make every transient Redis hiccup a lost email.

- [ ] **Step 6: Add naming convention rules to `eslint.config.mjs`**

In the `check-file/filename-naming-convention` object (lines 189-203), add:

```javascript
'src/jobs/**/*.ts': '*.job',
'src/workers/**/*.ts': '*.worker',
```

- [ ] **Step 7: Write unit tests for queue service**

Create `tests/unit/services/queue.service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { JobPriority } from '@/constants/queue.constants'

describe('JobPriority', () => {
  it('orders critical < high < normal < low', () => {
    expect(JobPriority.critical).toBeLessThan(JobPriority.high)
    expect(JobPriority.high).toBeLessThan(JobPriority.normal)
    expect(JobPriority.normal).toBeLessThan(JobPriority.low)
  })
})
```

Also test the `WORKER_ENABLED` parsing (can go in an existing env.config.test.ts or a new file):

```typescript
import { parseEnv } from '@/configs/env.config'

// Use a minimal valid env object matching the schema's required fields

it('parses WORKER_ENABLED=false as boolean false', () => {
  const env = parseEnv({ ...validTestEnv, WORKER_ENABLED: 'false' })
  expect(env.WORKER_ENABLED).toBe(false)
})

it('parses WORKER_ENABLED=true as boolean true', () => {
  const env = parseEnv({ ...validTestEnv, WORKER_ENABLED: 'true' })
  expect(env.WORKER_ENABLED).toBe(true)
})

it('defaults WORKER_ENABLED to true when unset', () => {
  const env = parseEnv({ ...validTestEnv })
  expect(env.WORKER_ENABLED).toBe(true)
})
```

- [ ] **Step 8: Write integration test for queue unreachable**

Create `tests/integration/services/queue-unreachable.service.test.ts`, modeled on the existing `redis-unreachable.service.test.ts`:

Test against a port where nothing is listening (e.g. `redis://localhost:19999`). Override `REDIS_URL` in `process.env` before importing the queue service (use `vi.resetModules()` + dynamic `import()` to get a fresh module with the test URL). Assert:

- `isQueueReachable()` returns `false` within a reasonable timeout (e.g. 10s)
- `getEmailQueue().add(...)` eventually rejects (after `retryStrategy` exhausts)
- Clean up the ioredis connection in `afterAll` to prevent test hangs

- [ ] **Step 9: Add lint-gates tests**

In `tests/unit/lint-gates.test.ts`, add:

```typescript
it('accepts a correctly named file in src/jobs/', async () => {
  const ids = await ruleIdsFor(
    'src/jobs/email.job.ts',
    '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
  )
  expect(ids).not.toContain('check-file/filename-naming-convention')
})

it('rejects a wrongly named file in src/jobs/', async () => {
  const messages = await messagesFor(
    'src/jobs/email.ts',
    '/**\n * P.\n * @returns text\n */\nexport function p(): string { return "x" }\n'
  )
  const checkFileMessage = messages.find(
    (message) => message.ruleId === 'check-file/filename-naming-convention'
  )
  expect(checkFileMessage?.severity).toBe(2)
})
```

Same pair for `src/workers/`.

- [ ] **Step 10: Regenerate `.env.example`**

```bash
pnpm env:example
```

Verify `WORKER_ENABLED` and `QUEUE_PREFIX` appear.

- [ ] **Step 11: Run all tests**

```bash
pnpm test
```

Expected: all existing tests pass plus the new ones.

- [ ] **Step 12: Commit**

```bash
git add src/services/queue.service.ts src/constants/queue.constants.ts src/configs/env.config.ts eslint.config.mjs tests/ package.json pnpm-lock.yaml .env.example
git commit -m "feat: add BullMQ queue service with ioredis connection and job priority constants"
```

---

### Task 2: Email Job + Worker + sendMail Return Change

**Files:**

- Create: `src/jobs/email.job.ts`
- Create: `src/workers/email.worker.ts`
- Modify: `src/services/mailer.service.ts` (line 344 — `sendMail()` returns `'sent' | 'failed'`)
- Modify: `tests/integration/services/mailer.service.test.ts` (6 assertions change from `toBeUndefined()`)
- Create: `tests/unit/workers/email.worker.test.ts`
- Create: `tests/integration/workers/email.worker.test.ts`

**Interfaces:**

- Consumes: `getEmailQueue()`, `addJob()`, `getQueueConnection()` from `@/services/queue.service`
- Consumes: `JobPriority` from `@/constants/queue.constants`
- Consumes: `sendMail(message: MailMessage)` from `@/services/mailer.service` — returns `'sent' | 'failed'`
- Consumes: `MailMessage` type from `@/services/mailer.service`
- Produces: `EmailJobData` — `MailMessage & { userId: string }`
- Produces: `addEmailJob(message: MailMessage, userId: string, opts?): Promise<Job<EmailJobData>>` — typed enqueue helper
- Produces: `emailJobDefaults: JobsOptions` — default options for email jobs
- Produces: `startEmailWorker(): Worker` — creates and returns the email worker
- Produces: `processEmailJob(job: Job<EmailJobData>): Promise<void>` — exported for unit testing

- [ ] **Step 1: Create `src/jobs/email.job.ts`**

```typescript
import { type Job, type JobsOptions } from 'bullmq'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getEmailQueue } from '@/services/queue.service'

export type EmailJobData = MailMessage & { userId: string }

export const emailJobDefaults: JobsOptions = {
  priority: JobPriority.high,
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000, // 4 waits: 5s, 10s, 20s, 40s
  },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
}

/**
 * Enqueue an email job.
 * @param message - The MailMessage (discriminated union — type-safe template + variables).
 * @param userId - The user this email is for (logging/correlation, not a DB lookup).
 * @param opts - Override default job options.
 */
export async function addEmailJob(
  message: MailMessage,
  userId: string,
  opts?: Partial<JobsOptions>
): Promise<Job<EmailJobData>> {
  return addJob(
    getEmailQueue(),
    message.templateKey,
    { ...message, userId },
    { ...emailJobDefaults, ...opts }
  )
}
```

**Key decisions:**

- `EmailJobData = MailMessage & { userId: string }` preserves the discriminated union — the worker can call `sendMail(job.data)` without a cast.
- `removeOnComplete: true` — delete the job from Redis immediately on success. The raw verification token is in `variables.verificationUrl`; keeping it in Redis for 24h is a security risk. `email_logs` is the audit trail.
- `removeOnFail: { age: 7 * 24 * 3600 }` — keep failed jobs for 7 days for operator inspection.

- [ ] **Step 2: Create `src/workers/email.worker.ts`**

```typescript
import { UnrecoverableError, Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import type { EmailJobData } from '@/jobs/email.job'
import { logger } from '@/services/logger.service'
import { sendMail } from '@/services/mailer.service'
import { getQueueConnection } from '@/services/queue.service'

/**
 * Process one email job. Exported for unit testing.
 *
 * `sendMail` never rejects (Ruling G). The worker checks the return value
 * to decide whether BullMQ should retry. A rendering failure (missing
 * template variable) is deterministic — retrying won't help — so it throws
 * `UnrecoverableError` to skip remaining attempts.
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const result = await sendMail(job.data)
  if (result === 'failed') {
    throw new Error(`Email job ${job.id} failed for template ${job.data.templateKey}`)
  }
}

/**
 * Start the email worker.
 * @returns The running Worker instance (for graceful shutdown).
 */
export function startEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>('email', processEmailJob, {
    connection: getQueueConnection(),
    prefix: getEnv().QUEUE_PREFIX,
    concurrency: 5,
    lockDuration: 30_000,
  })

  worker.on('completed', (job) => {
    logger.info('Email job completed', {
      jobId: job.id,
      templateKey: job.data.templateKey,
    })
  })

  worker.on('failed', (job, error) => {
    logger.error('Email job failed', {
      jobId: job?.id,
      templateKey: job?.data.templateKey,
      attempt: job?.attemptsMade,
      error,
    })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Email worker error', { error })
  })

  return worker
}
```

**Key decisions:**

- `worker.on('error', ...)` is mandatory — an unlistened `'error'` event on an `EventEmitter` crashes the process.
- The error thrown on failure includes `job.id` and `templateKey` only — NOT `email` (PII in BullMQ's `failedReason`, persisted in Redis).
- `prefix: getEnv().QUEUE_PREFIX` — matches the queue's prefix so the worker pulls from the right keys. In tests, this is `bull:test-w${VITEST_POOL_ID}`.

- [ ] **Step 3: Modify `sendMail()` return type**

In `src/services/mailer.service.ts`, change line 344:

```typescript
// Before (line 344):
export async function sendMail(message: MailMessage): Promise<void> {

// After:
export async function sendMail(message: MailMessage): Promise<'sent' | 'failed'> {
```

At the end of the function (after `await recordDelivery(entry)`, line 376), add the return:

```typescript
  await recordDelivery(entry)
  return entry.status === 'sent' ? 'sent' : 'failed'
}
```

Also update the JSDoc `@returns` line (line 342) to reflect the new return type.

This is backwards-compatible — existing callers that ignore the return value are unaffected. The never-reject guarantee (Ruling G) is unchanged.

- [ ] **Step 4: Fix mailer.service.test.ts assertions**

Six assertions at lines 412, 482, 550, 619, 707, 750 change from:

```typescript
await expect(sendMail(...)).resolves.toBeUndefined()
```

to either:

```typescript
await expect(sendMail(...)).resolves.toBe('sent')
// or
await expect(sendMail(...)).resolves.toBe('failed')
```

depending on the test scenario. Read each test's context to determine whether the scenario is a successful send or a failure. In general:

- Tests that mock a successful SMTP send → `'sent'`
- Tests that mock an SMTP failure → `'failed'`
- Tests with a bogus template key → `'failed'` (rendering error)

- [ ] **Step 5: Write unit tests for email worker**

Create `tests/unit/workers/email.worker.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import * as mailerService from '@/services/mailer.service'
import { processEmailJob } from '@/workers/email.worker'

vi.mock('@/services/mailer.service', () => ({
  sendMail: vi.fn(),
}))

const mockJob = (overrides = {}) => ({
  id: 'test-job-1',
  data: {
    to: 'user@example.com',
    templateKey: 'email_verification',
    variables: {
      firstName: 'Ada',
      verificationUrl: 'https://example.com/verify?token=abc',
      appName: 'Test',
    },
    userId: 'user-123',
  },
  ...overrides,
})

describe('processEmailJob', () => {
  it('resolves when sendMail returns sent', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('sent')
    await expect(processEmailJob(mockJob() as never)).resolves.toBeUndefined()
    expect(mailerService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@example.com', templateKey: 'email_verification' })
    )
  })

  it('throws when sendMail returns failed so BullMQ retries', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob() as never)).rejects.toThrow(/Email job/)
  })

  it('does not include email address in the thrown error message', async () => {
    vi.mocked(mailerService.sendMail).mockResolvedValue('failed')
    await expect(processEmailJob(mockJob() as never)).rejects.toThrow(
      expect.not.stringContaining('user@example.com')
    )
  })
})
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
```

Expected: all tests pass including the 6 fixed `mailer.service.test.ts` assertions and new worker tests.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/email.job.ts src/workers/email.worker.ts src/services/mailer.service.ts tests/
git commit -m "feat: add email job definition, worker, and sendMail return value for retry decisions"
```

---

### Task 3: Helper Migration + Boot/Shutdown/Health + CLAUDE.md

**Files:**

- Modify: `src/utilities/verification-mail.utilities.ts` (replace `sendMail()` with `addEmailJob()`)
- Modify: `src/controllers/auth.controller.ts` (replace `sendRegistrationAttemptMail` body, update imports)
- Modify: `src/controllers/verification.controller.ts` (update `resendVerificationMail` body)
- Modify: `src/index.ts` (start worker in `boot()` when `WORKER_ENABLED`)
- Modify: `src/server.ts` (extend `gracefulShutdown` to accept and close worker)
- Modify: `src/app.ts` (add `isQueueReachable()` to `/health/ready`)
- Modify: `CLAUDE.md` (add queue convention section)
- Modify: test files as needed for new env vars (`WORKER_ENABLED`, `QUEUE_PREFIX`)

**Interfaces:**

- Consumes: `addEmailJob(message, userId, opts?)` from `@/jobs/email.job`
- Consumes: `startEmailWorker()` from `@/workers/email.worker`
- Consumes: `isQueueReachable()`, `closeQueue()` from `@/services/queue.service`
- Consumes: `getEnv().WORKER_ENABLED` from `@/configs/env.config`
- Consumes: `JobPriority` from `@/constants/queue.constants`

**IMPORTANT:** The controller call sites (`sendVerificationMail(user).catch(...)`, `sendRegistrationAttemptMail(email).catch(...)`, `resendVerificationMail(user).catch(...)`) stay **byte-identical**. The change is inside the helper function bodies — they switch from `await sendMail({...})` to `await addEmailJob({...}, userId)`. This preserves:

- Ruling T (unhandled rejection = enumeration oracle)
- Token issuance logic in `sendVerificationMail`
- Token revocation ordering in `resendVerificationMail` (revoke BEFORE issue — load-bearing)
- Stored-name security in `sendRegistrationAttemptMail` (uses DB-stored firstName, never attacker-submitted)

- [ ] **Step 1: Modify `src/utilities/verification-mail.utilities.ts`**

Replace the import and body:

```typescript
// Before:
import { sendMail } from '@/services/mailer.service'
// ...
  await sendMail({
    to: user.email,
    templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
    variables: { ... },
  })

// After:
import { addEmailJob } from '@/jobs/email.job'
// ...
  await addEmailJob(
    {
      to: user.email,
      templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
      variables: { ... },
    },
    user.id
  )
```

The function still issues the token and builds the URL before enqueuing — that logic is unchanged.

- [ ] **Step 2: Modify `sendRegistrationAttemptMail` in `src/controllers/auth.controller.ts`**

Replace the import and body of the local `sendRegistrationAttemptMail` function:

```typescript
// Before (line 179):
  await sendMail({
    to: email,
    templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
    variables: { ... },
  })

// After:
  await addEmailJob(
    {
      to: email,
      templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
      variables: { ... },
    },
    existing?.id ?? ''
  )
```

Remove the `sendMail` import if it's no longer used. Add the `addEmailJob` import. The `JobPriority` import is needed if you want to override priority for registration-attempt emails (lower priority than verification — `JobPriority.normal`):

```typescript
await addEmailJob(
  { to: email, templateKey: ..., variables: ... },
  existing?.id ?? '',
  { priority: JobPriority.normal }
)
```

- [ ] **Step 3: Modify `resendVerificationMail` in `src/controllers/verification.controller.ts`**

The function body calls `sendVerificationMail(user)` — which was already modified in Step 1 to enqueue instead of send directly. So this function **needs no change** — it calls the already-modified helper. Verify by reading the function.

- [ ] **Step 4: Extend `gracefulShutdown` in `src/server.ts`**

```typescript
import { type Worker } from 'bullmq'
import { closeQueue } from '@/services/queue.service'

export async function gracefulShutdown(server: Server, worker?: Worker): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (worker) await worker.close()
  await Promise.allSettled([closeDatabase(), closeRedis(), closeQueue()])
}
```

The worker parameter is optional — `gracefulShutdown` still works without it (for `WORKER_ENABLED=false` pods).

- [ ] **Step 5: Start worker in `src/index.ts`**

In the `boot()` function, after `startServer()`:

```typescript
async function boot(): Promise<void> {
  const { startServer, gracefulShutdown } = await import('@/server')
  const server = startServer()

  let worker: import('bullmq').Worker | undefined
  if (getEnv().WORKER_ENABLED) {
    const { startEmailWorker } = await import('@/workers/email.worker')
    worker = startEmailWorker()
    // logger is available here — getEnv() already succeeded
    const { logger } = await import('@/services/logger.service')
    logger.info('Email worker started')
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      const forced = setTimeout(() => process.exit(1), GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      void gracefulShutdown(server, worker).then(() => {
        clearTimeout(forced)
        process.exit(0)
      })
    })
  }
}
```

The worker import is dynamic (same pattern as `@/server`) so it only loads when `WORKER_ENABLED=true`. This avoids the BullMQ connection opening in the lifecycle test that calls `startServer(0)`.

- [ ] **Step 6: Add queue to health check in `src/app.ts`**

Modify the `/health/ready` handler (line 60):

```typescript
import { isQueueReachable } from '@/services/queue.service'

app.get('/health/ready', async (_request, response) => {
  const [database, redis, queue] = await Promise.all([
    isDatabaseReachable(),
    isRedisReachable(),
    isQueueReachable(),
  ])
  const isReady = database && redis && queue
  response.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not-ready',
    checks: { database, redis, queue },
  })
})
```

- [ ] **Step 7: Update test env fixtures**

Any test that constructs a minimal `Env` object (e.g. `mailer.config.test.ts`, `auth.controller.test.ts`) needs `WORKER_ENABLED` and `QUEUE_PREFIX` added. Grep for existing Env fixtures:

```bash
grep -rn 'SLACK_LOG_LEVEL\|LOG_LEVEL.*error.*warn' tests/ --include='*.ts' | head -10
```

Add `WORKER_ENABLED: true` and `QUEUE_PREFIX: 'bull:test'` to each fixture.

- [ ] **Step 8: Update CLAUDE.md**

Add a section after "## Logging":

```markdown
## Job queue

- **`addEmailJob()` from `@/jobs/email.job`, not `sendMail()` directly.**
  Email sending goes through a BullMQ queue. The existing helpers
  (`sendVerificationMail`, `sendRegistrationAttemptMail`,
  `resendVerificationMail`) enqueue internally — controllers call the
  same helpers with the same `.catch()` pattern they always did.
- **`WORKER_ENABLED` gates the in-process worker.** Default `true` (API +
  worker in one process). Set `false` for API-only pods; a separate worker
  deployment sets `true` and processes jobs from the shared Redis queue.
- **`QUEUE_PREFIX` isolates test queues.** Each vitest worker gets
  `bull:test-w${VITEST_POOL_ID}` — same mechanism as per-worker databases.
  Without it, a Worker in pool 1 processes pool 2's jobs.
- **`sendMail()` returns `'sent' | 'failed'`**, not `void`. The worker uses
  this to decide whether BullMQ should retry. The never-reject guarantee
  (Ruling G) is unchanged.
```

- [ ] **Step 9: Regenerate `.env.example`**

```bash
pnpm env:example
```

- [ ] **Step 10: Run all tests**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 11: Run lint**

```bash
pnpm lint
```

- [ ] **Step 12: Commit**

```bash
git add src/ tests/ CLAUDE.md .env.example
git commit -m "feat: wire email helpers to enqueue via BullMQ, add worker boot and health check"
```
