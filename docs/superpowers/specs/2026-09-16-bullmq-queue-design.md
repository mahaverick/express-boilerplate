# BullMQ Job Queue — Design Spec (Sub-project 1 of 3)

Status: approved in brainstorming
Session: https://claude.ai/code/session_018W6fi5MwVob2Vr1AexY5Mu
Date: 2026-09-16
Stream: 2 of 7 (see `2026-09-16-boilerplate-roadmap.md`)
Decomposition: sub-project 1 (queue infrastructure + email job migration).
Sub-project 2 = notification system + preferences. Sub-project 3 = SSE real-time push.

## Problem

Email sending uses a fire-and-forget `.catch()` pattern across 3 controller
call sites (`auth.controller.ts:242,252`, `verification.controller.ts:148`).
This has three problems:

1. **No retry.** An SMTP failure (greylisting, transient outage, rate limit)
   permanently loses the email. The user never gets it and has no signal.
2. **No visibility.** A failed send is a `logger.error` line. There is no way
   to see how many jobs are pending, how many failed, or retry a specific one.
3. **No scalability.** The fire-and-forget runs in the same event loop as the
   HTTP request. Under load, SMTP round trips compete with request handling.
   In a multi-pod deployment behind a load balancer, there is no coordination.

Both Ofluence/core and Consequential/core use BullMQ with Redis for the same
pattern this design follows.

## Solution

A BullMQ job queue backed by the existing Redis instance, with:

- A queue service managing BullMQ connections and job enqueue
- An email worker that processes jobs by calling the existing `sendMail()`
- Priority levels and per-job-type retry with exponential backoff
- A `WORKER_ENABLED` env var for separating API and worker deployments
- Health check integration and graceful shutdown

## 1. Queue Service

**File:** `src/services/queue.service.ts`

### Connection

BullMQ uses `ioredis` under the hood (a transitive dependency of `bullmq`),
not the `node-redis` client in `redis.service.ts`. They cannot share a
connection — different client libraries. The queue service creates its own
`ioredis` connection using the same `REDIS_URL` from `getEnv()`.

Lazy-initialized, same pattern as `redis.service.ts` and `logger.service.ts`:
the connection is created on first use, not at module scope.

### Public API

```typescript
getEmailQueue(): Queue
addJob<T>(queue: Queue, jobName: string, data: T, opts?: Partial<JobsOptions>): Promise<Job<T>>
isQueueReachable(): Promise<boolean>
closeQueue(): Promise<void>
```

- `getEmailQueue()` returns the lazily-created email queue instance. Additional
  queues (notification, in sub-project 2) will follow the same pattern.
- `addJob()` is a thin wrapper around `queue.add()` that merges job-type
  defaults with caller overrides. The queue is passed explicitly so callers
  choose which queue to enqueue into.
- `isQueueReachable()` pings the BullMQ Redis connection. Added to
  `/health/ready` in `app.ts`.
- `closeQueue()` closes all queue instances and the shared connection. Added
  to `gracefulShutdown` in `server.ts`.

### Queue Name

The email queue is named `email`. BullMQ prefixes all Redis keys with
`bull:<queueName>:` by default (e.g. `bull:email:waiting`). No custom prefix
is needed for a single-app deployment; multi-tenant key isolation is an RBAC
concern (Stream 6).

## 2. Job Priorities

BullMQ uses lower number = higher priority. Exported as a const object from
a shared location so callers use names, not magic numbers.

**File:** `src/jobs/email.job.ts` (and shared by future job types)

| Name       | Value | Use case                                         |
| ---------- | ----- | ------------------------------------------------ |
| `critical` | 1     | Password reset emails (time-sensitive, security) |
| `high`     | 2     | Email verification, login alerts                 |
| `normal`   | 5     | Registration-attempt notifications               |
| `low`      | 10    | Digest emails, non-urgent notifications          |

```typescript
export const JobPriority = {
  critical: 1,
  high: 2,
  normal: 5,
  low: 10,
} as const
```

## 3. Email Job

**File:** `src/jobs/email.job.ts`

### Payload (Snapshot)

The job payload carries everything the worker needs to render and send the
email — no database lookup required. The `userId` is for logging/correlation,
not a foreign key the worker dereferences.

```typescript
export interface EmailJobData {
  userId: string
  email: string
  templateKey: string
  variables: Record<string, string>
}
```

### Default Options

```typescript
export const emailJobDefaults: JobsOptions = {
  priority: JobPriority.high,
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000, // 10s, 20s, 40s, 80s, 160s
  },
  removeOnComplete: { age: 24 * 3600 }, // keep completed jobs for 24h
  removeOnFail: { age: 7 * 24 * 3600 }, // keep failed jobs for 7 days
}
```

5 attempts with exponential backoff starting at 5s — SMTP failures are often
transient (greylisting, rate limits, connection resets). The backoff formula is
`delay * 2^(attempt-1)`: 5s, 10s, 20s, 40s, 80s.

### Enqueue Helper

A typed helper that callers use instead of raw `addJob()`:

```typescript
export async function addEmailJob(
  templateKey: string,
  data: Omit<EmailJobData, 'templateKey'>,
  opts?: Partial<JobsOptions>
): Promise<Job<EmailJobData>> {
  return addJob(
    getEmailQueue(),
    templateKey,
    { ...data, templateKey },
    { ...emailJobDefaults, ...opts }
  )
}
```

Callers in controllers:

```typescript
// Before (fire-and-forget):
sendVerificationMail(created).catch((error: unknown) => {
  logger.error('Verification mail failed', { error })
})

// After (queued):
addEmailJob('email_verification', {
  userId: created.id,
  email: created.email,
  variables: { firstName: created.firstName, verificationUrl },
}).catch((error: unknown) => {
  logger.error('Failed to enqueue verification email', { error })
})
```

The `.catch()` stays at the enqueue point — if Redis is down, the enqueue
fails silently (Ruling G still applies: the response to the user must not
differ based on whether the email was successfully enqueued).

## 4. Email Worker

**File:** `src/workers/email.worker.ts`

### Processing

The worker calls `sendMail()` from `mailer.service.ts` with a `MailMessage`
built from the job's snapshot payload. `sendMail()` already handles:

- Template rendering
- SMTP sending
- Recording the outcome in `email_logs`
- Never rejecting (Ruling G)

Since `sendMail()` never rejects, the worker's `processor` function also
never throws from `sendMail()` itself. However, BullMQ still needs the job
to fail on SMTP errors so it can retry. The worker should check the
`email_logs` outcome: if `sendMail()` recorded a `failed` status, the worker
should throw so BullMQ retries.

Alternative (simpler): the worker calls the lower-level transport directly,
bypassing `sendMail()`'s never-reject wrapper, so BullMQ's own retry handles
failures. But this duplicates the rendering and logging logic.

**Recommended approach:** Modify `sendMail()` to return the outcome
(`'sent' | 'failed'`), and have the worker throw when the outcome is
`'failed'`. This is a minimal change — `sendMail()` currently returns `void`,
changing it to return the status lets the worker make a retry decision without
duplicating any logic. The existing fire-and-forget callers (if any remain)
simply ignore the return value.

```typescript
// In email.worker.ts:
async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { email, templateKey, variables } = job.data
  const result = await sendMail({ to: email, templateKey, variables })
  if (result === 'failed') {
    throw new Error(`Email send failed for ${templateKey} to ${email}`)
  }
}
```

### Lifecycle

```typescript
export function startEmailWorker(): Worker {
  const worker = new Worker('email', processEmailJob, {
    connection: getQueueConnection(),
    concurrency: 5,
    lockDuration: 30_000,
  })

  worker.on('failed', (job, error) => {
    logger.error('Email job failed', {
      jobId: job?.id,
      templateKey: job?.data.templateKey,
      attempt: job?.attemptsMade,
      error,
    })
  })

  worker.on('completed', (job) => {
    logger.info('Email job completed', {
      jobId: job.id,
      templateKey: job.data.templateKey,
    })
  })

  return worker
}
```

- `concurrency: 5` — process up to 5 emails simultaneously per pod. Matches
  a typical SMTP provider's per-connection limit.
- `lockDuration: 30_000` — 30s. A single email send is bounded by the SMTP
  timeouts (connection 10s + greeting 15s + socket 20s = 45s worst case, but
  in practice under 5s). 30s gives ample room without holding locks too long.
- The `failed` event fires after all retries are exhausted.

### Stalled Job Handling

BullMQ has built-in stall detection. If a worker takes a lock but doesn't
renew it (crashed mid-job), the job is automatically retried on another
worker. No additional configuration needed — the default `stalledInterval`
(30s) is appropriate.

### Multi-pod

BullMQ is distributed by design. Multiple pods connect to the same Redis
and BullMQ guarantees:

- Each job is picked up by exactly one worker (atomic dequeue via Redis)
- No double-processing (distributed locks)
- Stalled jobs from a crashed pod are retried on a healthy pod
- Scaling is just adding pods — zero coordination needed

## 5. Worker Enabled Flag

**Env var:** `WORKER_ENABLED` — `z.coerce.boolean().default(true)`

Using `z.coerce.boolean()` so the env var accepts string values `"true"` /
`"false"` from the shell environment or `.env` file.

| Deployment             | `WORKER_ENABLED` | Behavior                                               |
| ---------------------- | ---------------- | ------------------------------------------------------ |
| Development / small    | `true` (default) | API + worker in one process                            |
| Production API pods    | `false`          | API only — enqueues jobs, does not process             |
| Production worker pods | `true`           | Worker only (does not need to listen on HTTP, but can) |

A truly separate worker binary (no HTTP listener) is a deployment optimisation
documented in a comment, not built — a single `pnpm start` that does both is
the boilerplate's shipped behavior.

## 6. Health Check

Extend `/health/ready` in `app.ts` to include queue reachability:

```typescript
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
```

`isQueueReachable()` pings the BullMQ ioredis connection. It is separate from
`isRedisReachable()` because they are different client connections to the same
Redis — one could fail while the other succeeds (e.g. connection pool exhaustion).

## 7. Graceful Shutdown

Extend `gracefulShutdown()` in `server.ts`:

```typescript
export async function gracefulShutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  // Worker drains first — finish the current job before closing the queue
  if (activeWorker) await activeWorker.close()
  await Promise.allSettled([closeDatabase(), closeRedis(), closeQueue()])
}
```

Order: HTTP server closes (no new requests → no new enqueues) → worker
finishes current job → queue/DB/Redis connections close.

## 8. Call Site Migration

3 call sites in 2 controllers migrate from fire-and-forget to queued:

| File                         | Line | Before                                                | After                                                                              |
| ---------------------------- | ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `auth.controller.ts`         | 242  | `sendVerificationMail(created).catch(...)`            | `addEmailJob('email_verification', { userId, email, variables }).catch(...)`       |
| `auth.controller.ts`         | 252  | `sendRegistrationAttemptMail(input.email).catch(...)` | `addEmailJob('registration_attempt', { userId: '', email, variables }).catch(...)` |
| `verification.controller.ts` | 148  | `resendVerificationMail(user).catch(...)`             | `addEmailJob('email_verification', { userId, email, variables }).catch(...)`       |

The `.catch()` pattern stays — enqueue failure is handled the same way SMTP
failure was: log and move on (Ruling G).

`sendVerificationMail()` and `resendVerificationMail()` in
`verification-mail.utilities.ts` may become unused after migration. If so,
they can be removed (they were thin wrappers around `sendMail()` that built
the template variables). The `sendRegistrationAttemptMail()` local function
in `auth.controller.ts` may also become unused.

## 9. `sendMail()` Return Value Change

`sendMail()` in `mailer.service.ts` currently returns `Promise<void>`. Change
to `Promise<'sent' | 'failed'>` so the worker can decide whether to retry:

```typescript
// Before:
export async function sendMail(message: MailMessage): Promise<void> {
  // ... try { send } catch { log } ... recordDelivery(entry)
}

// After:
export async function sendMail(message: MailMessage): Promise<'sent' | 'failed'> {
  // ... same logic, same never-reject guarantee ...
  await recordDelivery(entry)
  return entry.status === 'sent' ? 'sent' : 'failed'
}
```

This is backwards-compatible — existing callers that ignore the return value
(`sendMail(...).catch(...)`) are unaffected. The `never-reject` guarantee
(Ruling G) is unchanged — the function still catches all errors internally.

## 10. File Structure

**New files:**

| File                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `src/services/queue.service.ts` | BullMQ connection, queue instances, `addJob()`, health, shutdown        |
| `src/jobs/email.job.ts`         | Email job payload type, `JobPriority`, default options, `addEmailJob()` |
| `src/workers/email.worker.ts`   | Email worker — processes jobs via `sendMail()`                          |

**Modified files:**

| File                                         | Change                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `src/configs/env.config.ts`                  | Add `WORKER_ENABLED`                                                  |
| `src/services/mailer.service.ts`             | `sendMail()` returns `'sent' \| 'failed'` instead of `void`           |
| `src/controllers/auth.controller.ts`         | Replace 2 fire-and-forget calls with `addEmailJob()`                  |
| `src/controllers/verification.controller.ts` | Replace 1 fire-and-forget call with `addEmailJob()`                   |
| `src/app.ts`                                 | Add `isQueueReachable()` to `/health/ready`                           |
| `src/server.ts`                              | Start worker when `WORKER_ENABLED`, extend `gracefulShutdown`         |
| `eslint.config.mjs`                          | Add `src/jobs/*.job.ts`, `src/workers/*.worker.ts` naming conventions |
| `.env.example`                               | Regenerated                                                           |
| `package.json`                               | Add `bullmq`                                                          |

**New dependency:**

- `bullmq` — the only new package. Brings `ioredis` as a transitive dependency.
  No `@types/bullmq` needed — BullMQ ships its own types.

## 11. What This Does NOT Include

- **Notification jobs** — sub-project 2 (notification system)
- **SSE real-time push** — sub-project 3
- **Notification preferences** — sub-project 2
- **BullMQ dashboard (Bull Board)** — a dev tool, not core infrastructure
- **Rate limiting per queue** — SMTP-provider concern
- **Separate worker Dockerfile** — documented as a deployment option, not built
- **Dead letter queue** — BullMQ's built-in failed job retention (7 days) is sufficient
