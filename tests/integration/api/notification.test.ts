// tests/integration/api/notification.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts) — same convention as
// tests/integration/api/profile.test.ts: every user created here is
// deleted in afterEach, and notifications/notification_preferences cascade
// off that delete (ON DELETE CASCADE, notification.model.ts), so nothing
// else needs explicit cleanup.
//
// Authenticated requests sign a token directly with `signAccessToken`
// rather than going through POST /api/v1/auth/login, mirroring
// profile.test.ts's own reasoning: these tests are about what happens
// after authentication, not about login itself.
//
// PUT /preferences CANNOT be exercised end-to-end for a successful upsert
// in this file. NOTIFICATION_TYPES currently holds only 'verify_email',
// and CONFIGURABLE_NOTIFICATION_TYPES (notification.validators.ts)
// deliberately excludes it — so, as the task brief itself calls out, every
// well-formed preferences update is rejected until a second notification
// type with a disableable channel ships. The tests below cover that
// rejection (and the ordinary validation failures alongside it); a
// positive upsert-through-the-controller test has nothing to exercise it
// with yet. NotificationPreferenceRepository.upsert itself already has
// direct coverage in notification-preference.repository.test.ts, which
// does not go through this validator and so is unaffected by the empty
// configurable list.
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import type { Notification } from '@/database/models/notification.model'
import type { User } from '@/database/models/user.model'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/utilities/token.utilities'
import { request } from '../../helpers/request'

const app = createApp()
const userRepository = new UserRepository()
const notificationRepository = new NotificationRepository()

/**
 * The envelope every controller response is wrapped in
 * (response.utilities.ts), narrowed to the fields these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  data?: TData
  errors?: Record<string, string[]>
}

/**
 * The shape `GET /api/v1/notifications` returns as `data`.
 */
interface NotificationListBody {
  notifications: Notification[]
  nextCursor?: string
}

/**
 * The shape `GET`/`PUT /api/v1/notifications/preferences` return as `data`.
 */
interface PreferencesBody {
  preferences: Array<{ notificationType: string; emailEnabled: boolean; inAppEnabled: boolean }>
}

/**
 * Cast a supertest response's body to a known envelope shape. supertest
 * types `.body` as `any`; every access after this point is a normal,
 * type-checked property access rather than an unsafe one.
 * @param response - The supertest response.
 * @returns The response body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `notification-api-${randomUUID()}@example.test`
}

/**
 * Insert one `verify_email` notification directly through the repository,
 * bypassing the API — these tests are about reading/mutating notifications
 * that already exist, not about how one gets created.
 * @param userId - The owning user's id.
 * @param title - The notification's title. Defaults to a fixed string when omitted.
 * @returns The inserted notification.
 */
async function seedNotification(
  userId: string,
  title = 'Verify your email'
): Promise<Notification> {
  return notificationRepository.create({
    userId,
    type: 'verify_email',
    title,
    body: 'Click the link to verify your email address.',
  })
}

/**
 * Seed one notification the way the notification worker writes it, with a
 * non-null `dedupeKey`, so a response that leaks the column shows a value.
 * @param userId - The owning user's id.
 * @returns The inserted row.
 */
async function seedDedupedNotification(userId: string): Promise<Notification> {
  const row = await notificationRepository.createOnce({
    userId,
    type: 'verify_email',
    title: 'Verify your email',
    body: 'Click the link to verify your email address.',
    dedupeKey: `notification-job-${randomUUID()}-1`,
  })
  if (row === undefined) throw new Error('seed collided on a random dedupe key')
  return row
}

describe('/api/v1/notifications', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a disposable user row, sign an access token for it, and track
   * the row for cleanup.
   * @returns The created row and a valid bearer token for it.
   */
  async function createAuthenticatedUser(): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  describe('GET /api/v1/notifications', () => {
    it('returns an empty list for a user with no notifications', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<NotificationListBody>(response).data).toEqual({ notifications: [] })
    })

    it('paginates with a cursor, returning every notification exactly once across pages', async () => {
      const { user, token } = await createAuthenticatedUser()
      const seeded = [
        await seedNotification(user.id, 'First'),
        await seedNotification(user.id, 'Second'),
        await seedNotification(user.id, 'Third'),
      ]

      const firstPage = await request(app)
        .get('/api/v1/notifications?limit=2')
        .set('Authorization', `Bearer ${token}`)
      expect(firstPage.status).toBe(200)
      const firstBody = envelopeOf<NotificationListBody>(firstPage).data
      expect(firstBody?.notifications).toHaveLength(2)
      expect(firstBody?.nextCursor).toEqual(expect.any(String))

      const secondPage = await request(app)
        .get(`/api/v1/notifications?limit=2&cursor=${firstBody?.nextCursor}`)
        .set('Authorization', `Bearer ${token}`)
      expect(secondPage.status).toBe(200)
      const secondBody = envelopeOf<NotificationListBody>(secondPage).data
      expect(secondBody?.notifications).toHaveLength(1)
      expect(secondBody?.nextCursor).toBeUndefined()

      const seenIds = new Set(
        [...(firstBody?.notifications ?? []), ...(secondBody?.notifications ?? [])].map((n) => n.id)
      )
      expect(seenIds).toEqual(new Set(seeded.map((n) => n.id)))
    })

    it('treats a garbage cursor as no cursor, returning the first page rather than an error', async () => {
      const { user, token } = await createAuthenticatedUser()
      await seedNotification(user.id)

      const response = await request(app)
        .get('/api/v1/notifications?cursor=not-a-real-cursor')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<NotificationListBody>(response).data?.notifications).toHaveLength(1)
    })

    it('never returns another user’s notifications', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const { token: otherToken } = await createAuthenticatedUser()
      await seedNotification(owner.id)

      const response = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${otherToken}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<NotificationListBody>(response).data).toEqual({ notifications: [] })
    })

    it('does not expose the internal dedupeKey', async () => {
      const { user, token } = await createAuthenticatedUser()
      await seedDedupedNotification(user.id)

      const response = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const [listed] = envelopeOf<NotificationListBody>(response).data?.notifications ?? []
      expect(listed).toBeDefined()
      expect(listed).not.toHaveProperty('dedupeKey')
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).get('/api/v1/notifications')

      expect(response.status).toBe(401)
      expect(envelopeOf<NotificationListBody>(response).success).toBe(false)
    })
  })

  describe('PATCH /api/v1/notifications/:id/read', () => {
    it('marks an unread notification as read', async () => {
      const { user, token } = await createAuthenticatedUser()
      const notification = await seedNotification(user.id)

      const response = await request(app)
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      const data = envelopeOf<Notification>(response).data
      expect(data?.id).toBe(notification.id)
      expect(data?.readAt).not.toBeNull()

      const [row] = await sql`select read_at from notifications where id = ${notification.id}`
      expect(row?.read_at).not.toBeNull()
    })

    it('is idempotent for an already-read notification', async () => {
      const { user, token } = await createAuthenticatedUser()
      const notification = await seedNotification(user.id)
      await request(app)
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${token}`)

      const response = await request(app)
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<Notification>(response).data?.readAt).not.toBeNull()
    })

    it('does not expose the internal dedupeKey, first call or repeat', async () => {
      const { user, token } = await createAuthenticatedUser()
      const notification = await seedDedupedNotification(user.id)
      const path = `/api/v1/notifications/${notification.id}/read`

      const first = await request(app).patch(path).set('Authorization', `Bearer ${token}`)
      const repeat = await request(app).patch(path).set('Authorization', `Bearer ${token}`)

      expect(first.status).toBe(200)
      expect(envelopeOf<Notification>(first).data).not.toHaveProperty('dedupeKey')
      expect(repeat.status).toBe(200)
      expect(envelopeOf<Notification>(repeat).data).not.toHaveProperty('dedupeKey')
    })

    it('returns 404 for another user’s notification', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const { token: otherToken } = await createAuthenticatedUser()
      const notification = await seedNotification(owner.id)

      const response = await request(app)
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set('Authorization', `Bearer ${otherToken}`)

      expect(response.status).toBe(404)

      const [row] = await sql`select read_at from notifications where id = ${notification.id}`
      expect(row?.read_at).toBeNull() // the other user's request must not have touched it
    })

    it('returns 404 for a nonexistent id', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .patch(`/api/v1/notifications/${randomUUID()}/read`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })

    it('returns 400 for a malformed id', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .patch('/api/v1/notifications/not-a-uuid/read')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(400)
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).patch(`/api/v1/notifications/${randomUUID()}/read`)

      expect(response.status).toBe(401)
    })
  })

  describe('PATCH /api/v1/notifications/read-all', () => {
    it('marks every unread notification read and returns how many were updated', async () => {
      const { user, token } = await createAuthenticatedUser()
      await seedNotification(user.id, 'First')
      await seedNotification(user.id, 'Second')

      const response = await request(app)
        .patch('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<{ count: number }>(response).data).toEqual({ count: 2 })

      const rows = await sql`select read_at from notifications where user_id = ${user.id}`
      expect(rows.every((row) => row.read_at !== null)).toBe(true)
    })

    it('returns a zero count and touches nothing when there is nothing unread', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .patch('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<{ count: number }>(response).data).toEqual({ count: 0 })
    })

    it('never marks another user’s notifications read', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const { token: otherToken } = await createAuthenticatedUser()
      const notification = await seedNotification(owner.id)

      const response = await request(app)
        .patch('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${otherToken}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<{ count: number }>(response).data).toEqual({ count: 0 })

      const [row] = await sql`select read_at from notifications where id = ${notification.id}`
      expect(row?.read_at).toBeNull()
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).patch('/api/v1/notifications/read-all')

      expect(response.status).toBe(401)
    })
  })

  describe('DELETE /api/v1/notifications/:id', () => {
    it('deletes a notification', async () => {
      const { user, token } = await createAuthenticatedUser()
      const notification = await seedNotification(user.id)

      const response = await request(app)
        .delete(`/api/v1/notifications/${notification.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)

      const rows = await sql`select id from notifications where id = ${notification.id}`
      expect(rows).toHaveLength(0)
    })

    it('returns 404 for another user’s notification and leaves it intact', async () => {
      const { user: owner } = await createAuthenticatedUser()
      const { token: otherToken } = await createAuthenticatedUser()
      const notification = await seedNotification(owner.id)

      const response = await request(app)
        .delete(`/api/v1/notifications/${notification.id}`)
        .set('Authorization', `Bearer ${otherToken}`)

      expect(response.status).toBe(404)

      const rows = await sql`select id from notifications where id = ${notification.id}`
      expect(rows).toHaveLength(1)
    })

    it('returns 404 for a nonexistent id', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .delete(`/api/v1/notifications/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).delete(`/api/v1/notifications/${randomUUID()}`)

      expect(response.status).toBe(401)
    })
  })

  describe('GET /api/v1/notifications/preferences', () => {
    it('returns the full matrix with opt-out defaults for a user who never set any preference', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .get('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(envelopeOf<PreferencesBody>(response).data).toEqual({
        preferences: NOTIFICATION_TYPES.map((type) => ({
          notificationType: type,
          emailEnabled: true,
          inAppEnabled: true,
        })),
      })
    })

    it('rejects a request with no token', async () => {
      const response = await request(app).get('/api/v1/notifications/preferences')

      expect(response.status).toBe(401)
    })
  })

  describe('PUT /api/v1/notifications/preferences', () => {
    // See this file's header comment: NOTIFICATION_TYPES currently has only
    // 'verify_email', which CONFIGURABLE_NOTIFICATION_TYPES always excludes
    // — so this is a rejection, not a bug, and is the behaviour the task
    // brief explicitly calls for ("reject all updates until a second type
    // ... is added").
    it('rejects an update for verify_email with a clear, field-scoped message', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .put('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({
          preferences: [
            { notificationType: 'verify_email', emailEnabled: false, inAppEnabled: true },
          ],
        })

      expect(response.status).toBe(400)
      const errors = envelopeOf<PreferencesBody>(response).errors
      expect(errors?.preferences?.[0]).toMatch(/does not support a configurable preference/i)
    })

    it('does not write a preference row when the update is rejected', async () => {
      const { user, token } = await createAuthenticatedUser()

      await request(app)
        .put('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({
          preferences: [
            { notificationType: 'verify_email', emailEnabled: false, inAppEnabled: true },
          ],
        })

      const rows = await sql`select * from notification_preferences where user_id = ${user.id}`
      expect(rows).toHaveLength(0)
    })

    it('rejects an empty preferences array', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .put('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ preferences: [] })

      expect(response.status).toBe(400)
    })

    it('rejects an unknown notification type', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .put('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({
          preferences: [
            { notificationType: 'bogus_type', emailEnabled: false, inAppEnabled: true },
          ],
        })

      expect(response.status).toBe(400)
    })

    it('rejects a malformed body missing required fields', async () => {
      const { token } = await createAuthenticatedUser()

      const response = await request(app)
        .put('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${token}`)
        .send({ preferences: [{ notificationType: 'verify_email' }] })

      expect(response.status).toBe(400)
    })

    it('rejects a request with no token', async () => {
      const response = await request(app)
        .put('/api/v1/notifications/preferences')
        .send({ preferences: [] })

      expect(response.status).toBe(401)
    })
  })
})
