# In-App Notification System — Design Spec (Sub-project 2 of 3)

Status: approved in brainstorming
Session: https://claude.ai/code/session_018W6fi5MwVob2Vr1AexY5Mu
Date: 2026-09-16
Stream: 2 of 7, sub-project 2 (notification system + preferences).
Sub-project 1 = BullMQ queue (shipped). Sub-project 3 = SSE real-time push.

## Problem

Email is the only notification channel. There is no in-app notification
system, no way for users to see a history of events, and no way to control
which channels they receive notifications on. When the queue adds a
notification job, it can only send email — there is no in-app target.

## Solution

A full notification subsystem with:

- A `notifications` table for in-app notification history (list, read, delete)
- A `notification_preferences` table for per-user per-channel toggles (opt-out model)
- A notification worker that orchestrates channel fan-out (check preferences → in-app insert + email enqueue)
- REST API endpoints for notification CRUD and preference management
- Migration of existing email helpers to go through the notification worker instead of the email queue directly

## 1. Notification Model

**File:** `src/database/models/notification.model.ts`

### `notifications` table

| Column       | Type                | Constraints               | Notes                                             |
| ------------ | ------------------- | ------------------------- | ------------------------------------------------- |
| `id`         | `varchar(36)`       | PK, default `uuidv7()`    | Same pattern as `users`                           |
| `user_id`    | `varchar(36)`       | NOT NULL, FK → `users.id` | The recipient                                     |
| `type`       | `varchar(50)`       | NOT NULL                  | e.g. `email_verified`, `registration_attempt`     |
| `title`      | `varchar(255)`      | NOT NULL                  | Human-readable, shown in UI                       |
| `body`       | `text`              | NOT NULL                  | Notification content                              |
| `metadata`   | `jsonb`             | nullable                  | Type-specific data (templateKey, variables, etc.) |
| `read_at`    | `timestamp with tz` | nullable                  | null = unread                                     |
| `created_at` | `timestamp with tz` | NOT NULL, default `now()` |                                                   |

Index on `(user_id, created_at DESC)` for the list query.

### `notification_preferences` table

| Column              | Type          | Constraints               | Notes                        |
| ------------------- | ------------- | ------------------------- | ---------------------------- |
| `id`                | `varchar(36)` | PK, default `uuidv7()`    |                              |
| `user_id`           | `varchar(36)` | NOT NULL, FK → `users.id` |                              |
| `notification_type` | `varchar(50)` | NOT NULL                  | Matches `notifications.type` |
| `email_enabled`     | `boolean`     | NOT NULL, default `true`  |                              |
| `in_app_enabled`    | `boolean`     | NOT NULL, default `true`  |                              |

Unique constraint on `(user_id, notification_type)`.

### Default Behavior (Opt-Out Model)

When no preference row exists for a user + notification type combination,
both channels are enabled. The repository checks for a preference row;
absence = all channels on. Users opt out by setting a channel to `false`,
not in by setting it to `true`.

## 2. Notification Types Registry

**File:** `src/constants/notification.constants.ts`

```typescript
export const NOTIFICATION_TYPES = [
  'email_verified',
  'registration_attempt',
  'password_changed', // reserved for Stream 4 (forgot-password)
  'login_new_device', // reserved for future
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]
```

Used by validators to reject preference updates naming unknown types.
New notification types are added here — one line, one place.

## 3. Notification Job + Worker

### Job Payload

**File:** `src/jobs/notification.job.ts`

```typescript
export interface NotificationJobData {
  userId: string
  type: NotificationType
  title: string
  body: string
  metadata?: Record<string, unknown>
}
```

`metadata` carries channel-specific data. For email-capable notifications,
it includes `email`, `templateKey`, and `variables` so the notification
worker can reconstruct a `MailMessage` for the email queue.

### Default Options

```typescript
export const notificationJobDefaults: JobsOptions = {
  priority: JobPriority.normal,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000, // 3 waits: 2s, 4s, 8s
  },
  removeOnComplete: true,
  removeOnFail: { age: 3 * 24 * 3600 }, // 3 days
}
```

3 attempts — database writes rarely fail transiently. If the insert fails,
it's probably a schema issue, not worth 5 retries.

### Worker Behavior

**File:** `src/workers/notification.worker.ts`

The notification worker is the **orchestrator**. It checks preferences and
fans out to the enabled channels:

```
addNotificationJob() → notification queue
                            ↓
                  notification worker
                  ├─ check preferences (notification_preference.repository)
                  ├─ in-app enabled? → INSERT into notifications table
                  └─ email enabled?  → addEmailJob() → email queue → sendMail()
```

1. Look up `notification_preferences` for `(userId, type)`
2. If no preference row exists, both channels are enabled (opt-out default)
3. If `inAppEnabled`: insert into `notifications` table via repository
4. If `emailEnabled` AND `metadata` contains `email`, `templateKey`,
   `variables`: enqueue an email job via `addEmailJob()`
5. If `emailEnabled` but `metadata` lacks email fields: skip email silently
   (the notification type doesn't have an email template)

The worker never rejects — it logs failures and moves on (same Ruling G
principle as `sendMail()`). A failed in-app insert doesn't block the email
enqueue, and vice versa.

### Queue

A separate queue named `notification` (not the `email` queue). Separate
because:

- Different retry characteristics (3 attempts vs 5)
- Different priority defaults (normal vs high)
- Independent scaling — in production, notification workers and email
  workers can scale independently

`getNotificationQueue()` added to `queue.service.ts`, same pattern as
`getEmailQueue()`.

## 4. API Endpoints

All endpoints require authentication (`requireAuth` middleware).

**File:** `src/controllers/notification.controller.ts`
**File:** `src/routes/notification.routes.ts`

### `GET /api/v1/notifications`

List notifications for the authenticated user.

- Paginated, newest first (by `createdAt` DESC, `id` DESC)
- Query params: `limit` (default 20, max 100), `cursor` (opaque, for next page)
- Response:
  ```json
  {
    "success": true,
    "data": {
      "notifications": [...],
      "nextCursor": "..."
    }
  }
  ```
- Cursor-based pagination using `createdAt` + `id` composite. The cursor
  is a base64-encoded `{ createdAt, id }` pair. The query is
  `WHERE user_id = ? AND (created_at, id) < (?, ?)` — efficient with the
  `(user_id, created_at DESC)` index.

### `PATCH /api/v1/notifications/:id/read`

Mark one notification as read.

- Sets `readAt = now()` if currently null
- Returns the updated notification
- 404 if the notification doesn't exist or belongs to a different user

### `PATCH /api/v1/notifications/read-all`

Mark all unread notifications as read for the authenticated user.

- Sets `readAt = now()` on all rows where `userId = ? AND readAt IS NULL`
- Returns `{ count: N }` — number of notifications marked read

### `DELETE /api/v1/notifications/:id`

Delete one notification.

- Hard delete (not soft delete — notifications aren't worth the complexity)
- 404 if the notification doesn't exist or belongs to a different user

### `GET /api/v1/notifications/preferences`

Get notification preferences for the authenticated user.

- Returns all preference rows for the user
- Types without a preference row are implicitly "all channels on" —
  the response includes only explicitly-set preferences

### `PUT /api/v1/notifications/preferences`

Update notification preferences (bulk upsert).

- Body: `{ preferences: [{ notificationType, emailEnabled, inAppEnabled }] }`
- Upserts each preference — creates if missing, updates if present
- Only the types included in the request are affected; omitted types
  keep their current state
- Validates that `notificationType` is in `NOTIFICATION_TYPES`
- Returns the updated preferences

## 5. Migration of Existing Call Sites

Currently (after SP1), helpers call `addEmailJob()` directly. After this
sub-project, they switch to `addNotificationJob()`:

### `sendVerificationMail` (verification-mail.utilities.ts)

```typescript
// Before:
await addEmailJob(
  { to: user.email, templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY, variables },
  user.id
)

// After:
await addNotificationJob({
  userId: user.id,
  type: 'email_verified',
  title: 'Verify your email',
  body: `Please verify your email address for ${appName}.`,
  metadata: {
    email: user.email,
    templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY,
    variables,
  },
})
```

### `sendRegistrationAttemptMail` (auth.controller.ts)

```typescript
// Before:
await addEmailJob(
  { to: email, templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY, variables },
  existing?.id ?? '',
  { priority: JobPriority.normal }
)

// After:
await addNotificationJob({
  userId: existing?.id ?? '',
  type: 'registration_attempt',
  title: 'Registration attempt',
  body: `Someone tried to register with your email address on ${appName}.`,
  metadata: {
    email,
    templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY,
    variables,
  },
})
```

### Controller call sites

**Stay byte-identical.** The `.catch()` pattern on the helpers is preserved.
`resendVerificationMail` calls `sendVerificationMail` which is already
modified — no change needed.

## 6. Notification Repository

**File:** `src/repositories/notification.repository.ts`

Extends `BaseRepository` (same pattern as `UserRepository`):

- `list(userId, { limit, cursor })` — paginated, newest first
- `findByIdAndUser(id, userId)` — ownership check
- `markRead(id, userId)` — set `readAt = now()`
- `markAllRead(userId)` — bulk update, return count
- `deleteOne(id, userId)` — hard delete
- `create(data)` — insert a new notification

## 7. Notification Preference Repository

**File:** `src/repositories/notification-preference.repository.ts`

- `findByUser(userId)` — all preferences for a user
- `findByUserAndType(userId, type)` — single preference lookup
- `upsert(userId, type, { emailEnabled, inAppEnabled })` — create or update
- `isChannelEnabled(userId, type, channel: 'email' | 'in_app')` — returns
  `true` when no row exists (opt-out default) or the channel is enabled

## 8. File Structure

**New files:**

| File                                                     | Purpose                                       |
| -------------------------------------------------------- | --------------------------------------------- |
| `src/database/models/notification.model.ts`              | Both tables                                   |
| `src/repositories/notification.repository.ts`            | Notification CRUD                             |
| `src/repositories/notification-preference.repository.ts` | Preference get/upsert                         |
| `src/controllers/notification.controller.ts`             | API handlers                                  |
| `src/validators/notification.validators.ts`              | Request validation                            |
| `src/routes/notification.routes.ts`                      | Route wiring                                  |
| `src/constants/notification.constants.ts`                | Types registry, defaults                      |
| `src/jobs/notification.job.ts`                           | Job payload, defaults, `addNotificationJob()` |
| `src/workers/notification.worker.ts`                     | Orchestrator worker                           |

**Modified files:**

| File                                           | Change                                              |
| ---------------------------------------------- | --------------------------------------------------- |
| `src/services/queue.service.ts`                | Add `getNotificationQueue()`, extend `closeQueue()` |
| `src/utilities/verification-mail.utilities.ts` | `addEmailJob()` → `addNotificationJob()`            |
| `src/controllers/auth.controller.ts`           | `addEmailJob()` → `addNotificationJob()`            |
| `src/routes/index.routes.ts`                   | Mount notification router                           |
| `src/index.ts`                                 | Start notification worker                           |
| `src/server.ts`                                | Add notification worker to `gracefulShutdown`       |
| `CLAUDE.md`                                    | Document notification conventions                   |

**No new dependencies.**

## 9. What This Does NOT Include

- **SSE real-time push** — sub-project 3
- **Push notification channel** — reserved in preferences (`push` column not built)
- **Unread count endpoint** — derivable from `GET /notifications`
- **Notification grouping/batching** — a digest feature, not core
- **Email template for in-app notification digest** — no digest yet
- **Admin notification management** — RBAC concern (Stream 6)
