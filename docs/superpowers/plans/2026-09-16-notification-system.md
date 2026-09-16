# In-App Notification System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app notification system with a notifications table, notification preferences (per-user per-channel opt-out), a notification worker that orchestrates channel fan-out (in-app + email), REST API for notification CRUD and preference management, and migration of the verification-email helper to route through the notification worker.

**Architecture:** A notification worker receives `addNotificationJob()` calls, checks the user's channel preferences, and fans out: inserts an in-app row if `inAppEnabled`, and enqueues an email job via the existing `addEmailJob()` if `emailEnabled` and the job carries email data. Controllers call the same helpers with the same `.catch()` pattern — only the helper bodies change. `registration_attempt` stays on `addEmailJob()` directly (email-only — an in-app row would be an enumeration oracle).

**Tech Stack:** Drizzle ORM for models/migrations, BullMQ (already installed), Zod 4 for validation.

**Spec:** `docs/superpowers/specs/2026-09-16-notification-system-design.md`

## Global Constraints

- TypeScript pinned `~6.0.3`
- Zod 4.6.5
- No barrel files — import directly
- `getEnv()` is lazy and memoised
- File naming: `src/services/*.service.ts`, `src/repositories/*.repository.ts`, `src/controllers/*.controller.ts`, `src/validators/*.validators.ts`, `src/routes/*.routes.ts`, `src/database/models/*.model.ts`, `src/constants/*.constants.ts`, `src/jobs/*.job.ts`, `src/workers/*.worker.ts`
- `pnpm env:example` regenerates `.env.example` — never hand-edit it
- `pnpm db:migration:generate` generates migrations — commit the SQL + `meta/`
- Pre-commit runs `eslint` + `vitest --changed HEAD` (excluding `tests/integration/**`)
- Tests that hit Docker MUST live under `tests/integration/`
- Each vitest worker gets its own database via `VITEST_POOL_ID` and its own queue prefix
- FKs use `.references(() => userModel.id, { onDelete: 'cascade' })` (see `user-token.model.ts:120`)
- `BaseRepository` requires `SoftDeletableTableConfig` (columns: `id`, `deletedAt`, `updatedAt`). `notifications` hard-deletes and has no `deletedAt`/`updatedAt` — `NotificationRepository` does NOT extend `BaseRepository`
- `MailMessage` is a discriminated union — never bypass with `as MailMessage`
- `request.user` is `AuthenticatedUser` (`{ id, email, firstName, lastName }`) from `auth.middleware.ts`

## Spec Corrections (rulings against the spec)

1. **Spec §5 `registration_attempt`:** MUST stay on `addEmailJob()` directly — email-only, no in-app row, never routed through the notification worker. An in-app notification saying "someone tried to register with your email" is an enumeration oracle (inverts Ruling G). Also `userId: existing?.id ?? ''` is an FK violation when the user is soft-deleted.
2. **Spec §2 type name:** `email_verified` → `verify_email`. The notification fires BEFORE verification (it's a request, not a confirmation). `email_verified` should be reserved for a future "your email is now verified" notification.
3. **Spec §2 reserved types:** Drop `password_changed` and `login_new_device` — no producer exists. Add them when Stream 4/future work creates a caller.
4. **Spec §1 `notification_preferences.id`:** Drop the surrogate PK. `(user_id, notification_type)` is the natural key and already unique. Upsert is `INSERT ... ON CONFLICT (user_id, notification_type) DO UPDATE SET ...`.
5. **Spec §1 FK:** Add `ON DELETE CASCADE` on both tables' `user_id` FK (matches `user-token.model.ts:120`).
6. **Spec §4 cursor index:** `(user_id, created_at DESC)` is insufficient for cursor pagination. Need `(user_id, created_at DESC, id DESC)` as a composite index.
7. **Spec §4 cursor validation:** The cursor is user-controlled. Validate with Zod after base64 decode: `z.object({ createdAt: z.string().datetime(), id: z.string().uuid() })`. Reject on parse failure with 400.
8. **Spec §4 `GET /preferences`:** Return the full matrix — for each `NOTIFICATION_TYPES` entry, the row if it exists else `{ type, emailEnabled: true, inAppEnabled: true }`. Don't make the client know the type list.
9. **Spec §3 `metadata` security:** The in-app row's `metadata` must NOT store `variables` (which contains the raw verification token). Store `templateKey` only for provenance. The email fan-out reads `variables` from the job payload, not from the stored row.
10. **Spec §3 `NotificationJobData.email`:** Use `email?: MailMessage` (the full discriminated union) instead of decomposing into `metadata.email + metadata.templateKey + metadata.variables`. The worker does `if (data.email) await addEmailJob(data.email, data.userId)` — zero casts. The `MailMessage` is on the JOB payload (transient in Redis, removed on complete), never persisted to the notifications table.
11. **Spec §3 worker retry:** "Never rejects" contradicts `attempts: 3`. The worker MUST throw on in-app insert failure (so a DB blip retries). It must NOT throw on email enqueue failure (that has its own queue's retry). The retry count is meaningful only if the worker can throw.
12. **Spec §3 `verify_email` preference:** The `verify_email` email channel is not user-disableable — a user who disables email for verification locks themselves out of ever verifying. Either exclude `verify_email` from the preferences validator's allowed types, or have `isChannelEnabled` return `true` for it regardless.
13. **Spec §6 `NotificationRepository`:** Does NOT extend `BaseRepository`. `BaseRepository` requires `SoftDeletableTableConfig` (`deletedAt`, `updatedAt` columns). `notifications` has neither — it hard-deletes and has only `createdAt`. Write a standalone repository class.
14. **Spec §8 migration:** One migration, two tables (not two separate migrations). Use `pnpm db:migration:generate` then commit the SQL + `meta/`.

---

### Task 1: Models + Migration + Repositories + Constants

**Files:**

- Create: `src/database/models/notification.model.ts`
- Create: `src/repositories/notification.repository.ts`
- Create: `src/repositories/notification-preference.repository.ts`
- Create: `src/constants/notification.constants.ts`
- Create: `src/database/migrations/XXXX_*.sql` (generated by drizzle-kit)
- Create: `tests/unit/repositories/notification.repository.test.ts`
- Create: `tests/integration/repositories/notification.repository.test.ts`
- Create: `tests/integration/repositories/notification-preference.repository.test.ts`

**Interfaces:**

- Consumes: `userModel` from `@/database/models/user.model` (FK reference)
- Consumes: `getDatabase()` from `@/services/database.service`
- Produces: `notificationModel` — Drizzle table definition for `notifications`
- Produces: `notificationPreferenceModel` — Drizzle table definition for `notification_preferences`
- Produces: `Notification`, `NewNotification` — inferred types
- Produces: `NotificationPreference`, `NewNotificationPreference` — inferred types
- Produces: `NotificationRepository` — standalone class (NOT extending `BaseRepository`)
  - `create(data): Promise<Notification>`
  - `list(userId, { limit, cursor? }): Promise<{ notifications: Notification[]; nextCursor?: string }>`
  - `findByIdAndUser(id, userId): Promise<Notification | undefined>`
  - `markRead(id, userId): Promise<Notification | undefined>`
  - `markAllRead(userId): Promise<number>`
  - `deleteOne(id, userId): Promise<boolean>`
- Produces: `NotificationPreferenceRepository` — standalone class
  - `findByUser(userId): Promise<NotificationPreference[]>`
  - `upsert(userId, type, { emailEnabled, inAppEnabled }): Promise<NotificationPreference>`
  - `isChannelEnabled(userId, type, channel): Promise<boolean>` — returns `true` when no row exists (opt-out default), and always returns `true` for `verify_email` email channel
  - `getFullMatrix(userId): Promise<PreferenceMatrix>` — all types with defaults filled in
- Produces: `NOTIFICATION_TYPES`, `NotificationType` from `@/constants/notification.constants`

- [ ] **Step 1: Create `src/constants/notification.constants.ts`**

```typescript
export const NOTIFICATION_TYPES = ['verify_email'] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20
export const MAX_NOTIFICATION_PAGE_SIZE = 100
```

Only `verify_email` for now — add types when they have a producer. Not `email_verified` (wrong tense — the notification fires before verification).

- [ ] **Step 2: Create `src/database/models/notification.model.ts`**

```typescript
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { userModel } from '@/database/models/user.model'

export const notificationModel = pgTable(
  'notifications',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body').notNull(),
    metadata: jsonb('metadata'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notifications_user_created_idx').on(table.userId, table.createdAt, table.id)]
)

export type Notification = InferSelectModel<typeof notificationModel>
export type NewNotification = InferInsertModel<typeof notificationModel>

export const notificationPreferenceModel = pgTable(
  'notification_preferences',
  {
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    notificationType: varchar('notification_type', { length: 50 }).notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.userId, table.notificationType] })]
)

export type NotificationPreference = InferSelectModel<typeof notificationPreferenceModel>
export type NewNotificationPreference = InferInsertModel<typeof notificationPreferenceModel>
```

Key decisions:

- `notificationPreferenceModel` uses composite PK `(userId, notificationType)` — no surrogate `id`. Upsert targets this composite.
- `notificationModel` index is `(userId, createdAt, id)` — supports cursor pagination `WHERE user_id = ? AND (created_at, id) < (?, ?)`.
- Both FKs use `onDelete: 'cascade'` matching `user-token.model.ts:120`.
- No `deletedAt` or `updatedAt` on either table — hard delete, no soft delete.

- [ ] **Step 3: Generate migration**

```bash
pnpm db:migration:generate
```

This creates a migration SQL file in `src/database/migrations/`. Review the generated SQL — verify it creates both tables with the correct constraints. Commit the SQL + `meta/` files.

Then run the migration against the test databases:

```bash
pnpm db:migrate
```

- [ ] **Step 4: Create `src/repositories/notification.repository.ts`**

A standalone class — does NOT extend `BaseRepository` (no `deletedAt`/`updatedAt`).

```typescript
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import {
  notificationModel,
  type NewNotification,
  type Notification,
} from '@/database/models/notification.model'
import { getDatabase } from '@/services/database.service'

export class NotificationRepository {
  async create(data: NewNotification): Promise<Notification> {
    const db = getDatabase()
    const [row] = await db.insert(notificationModel).values(data).returning()
    return row
  }

  async list(
    userId: string,
    options: { limit: number; cursor?: { createdAt: Date; id: string } }
  ): Promise<{ notifications: Notification[]; nextCursor?: string }> {
    const db = getDatabase()
    const conditions = [eq(notificationModel.userId, userId)]

    if (options.cursor) {
      conditions.push(
        sql`(${notificationModel.createdAt}, ${notificationModel.id}) < (${options.cursor.createdAt}, ${options.cursor.id})`
      )
    }

    const notifications = await db
      .select()
      .from(notificationModel)
      .where(and(...conditions))
      .orderBy(desc(notificationModel.createdAt), desc(notificationModel.id))
      .limit(options.limit + 1) // fetch one extra to detect next page

    const hasMore = notifications.length > options.limit
    if (hasMore) notifications.pop()

    const nextCursor =
      hasMore && notifications.length > 0
        ? Buffer.from(
            JSON.stringify({
              createdAt: notifications.at(-1)!.createdAt.toISOString(),
              id: notifications.at(-1)!.id,
            })
          ).toString('base64url')
        : undefined

    return { notifications, nextCursor }
  }

  async findByIdAndUser(id: string, userId: string): Promise<Notification | undefined> {
    const db = getDatabase()
    const [row] = await db
      .select()
      .from(notificationModel)
      .where(and(eq(notificationModel.id, id), eq(notificationModel.userId, userId)))
    return row
  }

  async markRead(id: string, userId: string): Promise<Notification | undefined> {
    const db = getDatabase()
    const [row] = await db
      .update(notificationModel)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notificationModel.id, id),
          eq(notificationModel.userId, userId),
          isNull(notificationModel.readAt)
        )
      )
      .returning()
    return row
  }

  async markAllRead(userId: string): Promise<number> {
    const db = getDatabase()
    const result = await db
      .update(notificationModel)
      .set({ readAt: sql`now()` })
      .where(and(eq(notificationModel.userId, userId), isNull(notificationModel.readAt)))
    return result.rowCount ?? 0
  }

  async deleteOne(id: string, userId: string): Promise<boolean> {
    const db = getDatabase()
    const result = await db
      .delete(notificationModel)
      .where(and(eq(notificationModel.id, id), eq(notificationModel.userId, userId)))
    return (result.rowCount ?? 0) > 0
  }
}
```

- [ ] **Step 5: Create `src/repositories/notification-preference.repository.ts`**

```typescript
import { and, eq } from 'drizzle-orm'
import { NOTIFICATION_TYPES, type NotificationType } from '@/constants/notification.constants'
import {
  notificationPreferenceModel,
  type NotificationPreference,
} from '@/database/models/notification.model'
import { getDatabase } from '@/services/database.service'

const NON_DISABLEABLE_EMAIL_TYPES: ReadonlySet<string> = new Set<string>(['verify_email'])

export class NotificationPreferenceRepository {
  async findByUser(userId: string): Promise<NotificationPreference[]> {
    const db = getDatabase()
    return db
      .select()
      .from(notificationPreferenceModel)
      .where(eq(notificationPreferenceModel.userId, userId))
  }

  async upsert(
    userId: string,
    notificationType: NotificationType,
    data: { emailEnabled: boolean; inAppEnabled: boolean }
  ): Promise<NotificationPreference> {
    const db = getDatabase()
    const [row] = await db
      .insert(notificationPreferenceModel)
      .values({ userId, notificationType, ...data })
      .onConflictDoUpdate({
        target: [notificationPreferenceModel.userId, notificationPreferenceModel.notificationType],
        set: data,
      })
      .returning()
    return row
  }

  async isChannelEnabled(
    userId: string,
    type: NotificationType,
    channel: 'email' | 'in_app'
  ): Promise<boolean> {
    // verify_email email channel is never user-disableable
    if (channel === 'email' && NON_DISABLEABLE_EMAIL_TYPES.has(type)) return true

    const db = getDatabase()
    const [row] = await db
      .select()
      .from(notificationPreferenceModel)
      .where(
        and(
          eq(notificationPreferenceModel.userId, userId),
          eq(notificationPreferenceModel.notificationType, type)
        )
      )

    if (!row) return true // opt-out default: no row = enabled
    return channel === 'email' ? row.emailEnabled : row.inAppEnabled
  }

  async getFullMatrix(userId: string): Promise<
    Array<{
      notificationType: NotificationType
      emailEnabled: boolean
      inAppEnabled: boolean
    }>
  > {
    const rows = await this.findByUser(userId)
    const byType = new Map(rows.map((r) => [r.notificationType, r]))

    return NOTIFICATION_TYPES.map((type) => {
      const row = byType.get(type)
      return {
        notificationType: type,
        emailEnabled: row?.emailEnabled ?? true,
        inAppEnabled: row?.inAppEnabled ?? true,
      }
    })
  }
}
```

Key: `isChannelEnabled` always returns `true` for `verify_email` email channel — a user who disables email for verification would lock themselves out of ever verifying.

- [ ] **Step 6: Write integration tests for both repositories**

Create `tests/integration/repositories/notification.repository.test.ts` — test list (with pagination), create, findByIdAndUser (ownership check), markRead, markAllRead, deleteOne. Uses real database (per-worker). Create test users via `UserRepository`.

Create `tests/integration/repositories/notification-preference.repository.test.ts` — test upsert (create + update), findByUser, isChannelEnabled (with row, without row, verify_email override), getFullMatrix.

- [ ] **Step 7: Run tests, verify migration works**

```bash
pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add src/database/models/notification.model.ts src/repositories/notification.repository.ts src/repositories/notification-preference.repository.ts src/constants/notification.constants.ts src/database/migrations/ tests/
git commit -m "feat: add notification and preference models, repositories, and migration"
```

---

### Task 2: Notification Job + Worker + Queue Extension

**Files:**

- Create: `src/jobs/notification.job.ts`
- Create: `src/workers/notification.worker.ts`
- Modify: `src/services/queue.service.ts` (add `getNotificationQueue()`, extend `closeQueue()`)
- Create: `tests/unit/workers/notification.worker.test.ts`
- Create: `tests/integration/workers/notification.worker.test.ts`

**Interfaces:**

- Consumes: `NotificationRepository` from `@/repositories/notification.repository`
- Consumes: `NotificationPreferenceRepository` from `@/repositories/notification-preference.repository`
- Consumes: `addEmailJob` from `@/jobs/email.job`
- Consumes: `addJob`, `getQueueConnection` from `@/services/queue.service`
- Consumes: `JobPriority` from `@/constants/queue.constants`
- Consumes: `NotificationType` from `@/constants/notification.constants`
- Consumes: `MailMessage` from `@/services/mailer.service`
- Produces: `NotificationJobData` — `{ userId: string; type: NotificationType; title: string; body: string; metadata?: Record<string, unknown>; email?: MailMessage }`
- Produces: `addNotificationJob(data: NotificationJobData, opts?): Promise<Job>`
- Produces: `startNotificationWorker(): Worker`

- [ ] **Step 1: Extend `src/services/queue.service.ts`**

Add `getNotificationQueue()` following the `getEmailQueue()` pattern. Add `state.notificationQueue` to the state object. Extend `closeQueue()` to close the notification queue. Add `queue.on('error', ...)` for the notification queue.

- [ ] **Step 2: Create `src/jobs/notification.job.ts`**

```typescript
import { type Job, type JobsOptions } from 'bullmq'
import type { NotificationType } from '@/constants/notification.constants'
import { JobPriority } from '@/constants/queue.constants'
import type { MailMessage } from '@/services/mailer.service'
import { addJob, getNotificationQueue } from '@/services/queue.service'

export interface NotificationJobData {
  userId: string
  type: NotificationType
  title: string
  body: string
  metadata?: Record<string, unknown>
  email?: MailMessage
}

export const notificationJobDefaults: JobsOptions = {
  priority: JobPriority.normal,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: true,
  removeOnFail: { age: 3 * 24 * 3600 },
}

export async function addNotificationJob(
  data: NotificationJobData,
  options?: Partial<JobsOptions>
): Promise<Job<NotificationJobData>> {
  return addJob(getNotificationQueue(), data.type, data, { ...notificationJobDefaults, ...options })
}
```

Key: `email?: MailMessage` carries the full discriminated union — the worker does `if (data.email) await addEmailJob(data.email, data.userId)` with zero casts. The `MailMessage` is transient in Redis (removed on complete), never persisted to the notifications table.

- [ ] **Step 3: Create `src/workers/notification.worker.ts`**

```typescript
import { Worker, type Job } from 'bullmq'
import { getEnv } from '@/configs/env.config'
import { addEmailJob } from '@/jobs/email.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { NotificationRepository } from '@/repositories/notification.repository'
import { logger } from '@/services/logger.service'
import { getQueueConnection } from '@/services/queue.service'

const notificationRepository = new NotificationRepository()
const preferenceRepository = new NotificationPreferenceRepository()

export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, type, title, body, metadata, email } = job.data

  // In-app channel
  const inAppEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'in_app')
  if (inAppEnabled) {
    // Strip email-specific data (variables contain tokens) — store only
    // templateKey for provenance. The raw token must NOT reach Postgres.
    const safeMetadata = metadata ? { ...metadata } : undefined
    if (safeMetadata) delete safeMetadata.variables

    await notificationRepository.create({
      userId,
      type,
      title,
      body,
      metadata: safeMetadata,
    })
  }

  // Email channel — enqueue failure is not thrown (email queue has its own retry)
  if (email) {
    const emailEnabled = await preferenceRepository.isChannelEnabled(userId, type, 'email')
    if (emailEnabled) {
      await addEmailJob(email, userId).catch((error: unknown) => {
        logger.error('Failed to enqueue email from notification worker', { error })
      })
    }
  }
}

export function startNotificationWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>('notification', processNotificationJob, {
    connection: getQueueConnection(),
    prefix: getEnv().QUEUE_PREFIX,
    concurrency: 5,
    lockDuration: 30_000,
  })

  worker.on('completed', (job) => {
    logger.info('Notification job completed', { jobId: job.id, type: job.data.type })
  })

  worker.on('failed', (job, error) => {
    logger.error('Notification job failed', {
      jobId: job?.id,
      type: job?.data.type,
      attempt: job?.attemptsMade,
      error,
    })
  })

  worker.on('error', (error: unknown) => {
    logger.error('Notification worker error', { error })
  })

  return worker
}
```

Key decisions:

- Worker THROWS on in-app insert failure (the `create()` call propagates) → BullMQ retries with `attempts: 3`.
- Worker does NOT throw on email enqueue failure → `.catch()` logs it, email queue has its own retry.
- `safeMetadata` strips `variables` before persisting to Postgres (tokens must not reach durable storage).
- `email?: MailMessage` is passed directly to `addEmailJob(email, userId)` — zero casts.

- [ ] **Step 4: Write unit tests for notification worker**

Create `tests/unit/workers/notification.worker.test.ts` — mock both repositories and `addEmailJob`. Test:

- In-app insert when inAppEnabled (verify metadata stripped of variables)
- No in-app insert when inAppEnabled=false
- Email enqueue when emailEnabled and email present
- No email enqueue when emailEnabled=false
- No email enqueue when email absent
- Throws on in-app insert failure (BullMQ retries)
- Does NOT throw on email enqueue failure

- [ ] **Step 5: Write integration test for notification worker**

Create `tests/integration/workers/notification.worker.test.ts` — start a real worker, enqueue a job with `email` field, assert:

- Notification row created in database
- Email job appears in email queue (or Mailpit if email worker also running)
- Metadata in the row does NOT contain `variables`
- `afterAll`: close worker, obliterate both queues, close queue connection

- [ ] **Step 6: Run tests**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add src/jobs/notification.job.ts src/workers/notification.worker.ts src/services/queue.service.ts tests/
git commit -m "feat: add notification job, worker with channel fan-out, and queue extension"
```

---

### Task 3: Controller + Validators + Routes + API Tests

**Files:**

- Create: `src/controllers/notification.controller.ts`
- Create: `src/validators/notification.validators.ts`
- Create: `src/routes/notification.routes.ts`
- Modify: `src/routes/index.routes.ts` (mount notification router)
- Create: `tests/integration/api/notification.test.ts`

**Interfaces:**

- Consumes: `NotificationRepository` from `@/repositories/notification.repository`
- Consumes: `NotificationPreferenceRepository` from `@/repositories/notification-preference.repository`
- Consumes: `requireAuth` from `@/middlewares/auth.middleware`
- Consumes: `NOTIFICATION_TYPES`, `NotificationType`, `DEFAULT_NOTIFICATION_PAGE_SIZE`, `MAX_NOTIFICATION_PAGE_SIZE` from `@/constants/notification.constants`
- Consumes: `successResponse`, `errorResponse` from `@/utilities/response.utilities`
- Consumes: `HttpError` from `@/middlewares/error.middleware`
- Produces: 6 route handlers (list, markRead, markAllRead, delete, getPreferences, updatePreferences)

- [ ] **Step 1: Create `src/validators/notification.validators.ts`**

```typescript
import { z } from 'zod'
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_TYPES,
} from '@/constants/notification.constants'

export const listNotificationsSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATION_PAGE_SIZE)
    .default(DEFAULT_NOTIFICATION_PAGE_SIZE),
  cursor: z.string().optional(),
})

export const notificationIdSchema = z.object({
  id: z.string().uuid(),
})

const cursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
})

export function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  const parsed = cursorSchema.parse(decoded)
  return { createdAt: new Date(parsed.createdAt), id: parsed.id }
}

// verify_email excluded — email channel is not user-disableable for it
const CONFIGURABLE_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter((t) => t !== 'verify_email')

export const updatePreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        notificationType: z.enum(
          CONFIGURABLE_NOTIFICATION_TYPES as unknown as [string, ...string[]]
        ),
        emailEnabled: z.boolean(),
        inAppEnabled: z.boolean(),
      })
    )
    .min(1),
})
```

Note: `verify_email` is excluded from the configurable types — users cannot disable email for verification.

- [ ] **Step 2: Create `src/controllers/notification.controller.ts`**

Six handlers, all behind `requireAuth`:

- `listNotifications` — parse query params, call `repository.list()`, return paginated response
- `markRead` — parse `:id`, call `repository.markRead()`, 404 if not found
- `markAllRead` — call `repository.markAllRead()`, return count
- `deleteNotification` — parse `:id`, call `repository.deleteOne()`, 404 if not found
- `getPreferences` — call `preferenceRepository.getFullMatrix()`, return full matrix
- `updatePreferences` — parse body, loop and `upsert()` each, return updated preferences

All handlers use `request.user!.id` for the userId (requireAuth guarantees it).

- [ ] **Step 3: Create `src/routes/notification.routes.ts`**

```typescript
import { Router } from 'express'
import { requireAuth } from '@/middlewares/auth.middleware'
import { ... } from '@/controllers/notification.controller'

export function createNotificationRouter(): Router {
  const router = Router()
  router.use(requireAuth)

  router.get('/', listNotifications)
  router.patch('/:id/read', markRead)
  router.patch('/read-all', markAllRead)
  router.delete('/:id', deleteNotification)
  router.get('/preferences', getPreferences)
  router.put('/preferences', updatePreferences)

  return router
}
```

- [ ] **Step 4: Mount in `src/routes/index.routes.ts`**

Add:

```typescript
import { createNotificationRouter } from '@/routes/notification.routes'

// ...
router.use('/notifications', createNotificationRouter())
```

- [ ] **Step 5: Write integration tests**

Create `tests/integration/api/notification.test.ts` — test all 6 endpoints via supertest:

- List: empty list, create notifications then paginate, cursor works
- Mark read: marks unread as read, 404 for wrong user's notification
- Mark all read: bulk update, returns count
- Delete: removes notification, 404 for wrong user
- Get preferences: returns full matrix with defaults
- Update preferences: upserts, validates types, rejects `verify_email`
- Auth: all endpoints return 401 without token

- [ ] **Step 6: Run tests**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add src/controllers/notification.controller.ts src/validators/notification.validators.ts src/routes/notification.routes.ts src/routes/index.routes.ts tests/
git commit -m "feat: add notification CRUD and preference API endpoints"
```

---

### Task 4: Helper Migration + Boot/Shutdown + Test Updates + Docs

**Files:**

- Modify: `src/utilities/verification-mail.utilities.ts` (`addEmailJob()` → `addNotificationJob()`)
- Modify: `src/index.ts` (start notification worker alongside email worker)
- Modify: `src/server.ts` (extend `gracefulShutdown` for notification worker)
- Modify: `tests/integration/api/auth.test.ts` (add `startNotificationWorker()` + cleanup)
- Modify: `tests/integration/api/verification.test.ts` (add `startNotificationWorker()` + cleanup)
- Modify: `CLAUDE.md` (document notification conventions)

**Interfaces:**

- Consumes: `addNotificationJob` from `@/jobs/notification.job`
- Consumes: `startNotificationWorker` from `@/workers/notification.worker`
- Consumes: `closeQueue` from `@/services/queue.service`

**CRITICAL — `registration_attempt` stays on `addEmailJob()`:**
Only `sendVerificationMail` switches to `addNotificationJob()`. `sendRegistrationAttemptMail` keeps its existing `addEmailJob()` call — email-only, no in-app row (enumeration oracle).

- [ ] **Step 1: Modify `src/utilities/verification-mail.utilities.ts`**

Replace:

```typescript
import { addEmailJob } from '@/jobs/email.job'
```

with:

```typescript
import { addNotificationJob } from '@/jobs/notification.job'
```

Replace the `addEmailJob()` call with:

```typescript
await addNotificationJob({
  userId: user.id,
  type: 'verify_email',
  title: 'Verify your email',
  body: `Please verify your email address for ${getEnv().APP_NAME}.`,
  metadata: { templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY },
  email: {
    to: user.email,
    templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
    variables: {
      firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
      verificationUrl: buildVerificationUrl(issued.raw),
      appName: getEnv().APP_NAME,
    },
  },
})
```

The token issuance (`issueToken(...)`) stays before the enqueue — unchanged.

- [ ] **Step 2: Start notification worker in `src/index.ts`**

In `boot()`, after starting the email worker:

```typescript
if (getEnv().WORKER_ENABLED) {
  const { startEmailWorker } = await import('@/workers/email.worker')
  const { startNotificationWorker } = await import('@/workers/notification.worker')
  emailWorker = startEmailWorker()
  notificationWorker = startNotificationWorker()
  const { logger } = await import('@/services/logger.service')
  logger.info('Workers started (email + notification)')
}
```

Pass both workers to `gracefulShutdown(server, emailWorker, notificationWorker)`.

- [ ] **Step 3: Extend `gracefulShutdown` in `src/server.ts`**

```typescript
export async function gracefulShutdown(
  server: Server,
  emailWorker?: Worker,
  notificationWorker?: Worker
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Promise.allSettled([emailWorker?.close(), notificationWorker?.close()].filter(Boolean))
  await Promise.allSettled([closeDatabase(), closeRedis(), closeQueue()])
}
```

Both workers drain before connections close.

- [ ] **Step 4: Update test files that assert Mailpit delivery**

`tests/integration/api/auth.test.ts` and `tests/integration/api/verification.test.ts` both start an email worker. After this change, the email job only exists AFTER the notification worker fans out. These files need a `startNotificationWorker()` too.

Add at module scope (same pattern as the email worker):

```typescript
import { startNotificationWorker } from '@/workers/notification.worker'

const notificationWorker = startNotificationWorker()
```

In `afterAll`, close both workers, obliterate both queues:

```typescript
afterAll(async () => {
  await worker.close()
  await notificationWorker.close()
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})
```

Import `getNotificationQueue` from `@/services/queue.service`.

- [ ] **Step 5: Update CLAUDE.md**

Add after the "## Job queue" section:

```markdown
## Notifications

- **`addNotificationJob()` from `@/jobs/notification.job`, not `addEmailJob()`
  directly,** for events that have both in-app and email channels. The
  notification worker checks preferences and fans out. `registration_attempt`
  is the exception — email-only, never routed through the notification worker
  (an in-app row would be an enumeration oracle — see Ruling G).
- **`verify_email` email channel is not user-disableable.** A user who
  disables email for verification locks themselves out. The preference
  repository returns `true` for it regardless.
- **`metadata` on the notifications table must NOT contain `variables`.**
  Verification tokens live in `variables`. The worker strips them before
  the database insert — the email fan-out reads them from the job payload,
  not from the stored row.
```

- [ ] **Step 6: Run all tests**

```bash
pnpm test
pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add src/ tests/ CLAUDE.md
git commit -m "feat: wire verification email through notification worker and start notification worker at boot"
```
