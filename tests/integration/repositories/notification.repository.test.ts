// tests/integration/repositories/notification.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every user this file creates is
// deleted in afterEach — deleting the user is enough: notifications.user_id
// carries ON DELETE CASCADE (notification.model.ts), so a row this file
// never explicitly deletes is still gone once its owning user is. One
// cascade test below asserts that property directly, since it's a schema
// guarantee this task itself introduced, not an assumption to leave
// unverified.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeNotificationCursor,
  NotificationRepository,
  type NotificationCursor,
} from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const notificationRepository = new NotificationRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `notification-repo-${randomUUID()}@example.test`
}

/**
 * Page through an entire inbox with a page size far smaller than the
 * total, following the real `nextCursor` each time, and return the set of
 * every id seen across every page plus how many pages it took. Shared by
 * both pagination tests below — the only difference between them is how
 * `createdAt` was assigned to the rows being paged through.
 * @param userId - The user whose notifications to page through.
 * @param expectedIds - Every id the caller expects to see exactly once, used only to size the safety-valve page limit.
 * @returns The set of ids seen across every page, and how many pages were fetched.
 */
async function pageThroughAll(
  userId: string,
  expectedIds: Set<string>
): Promise<{ seenIds: Set<string>; pageCount: number }> {
  const seenIds = new Set<string>()
  let cursor: NotificationCursor | undefined
  let pageCount = 0
  const maxPages = expectedIds.size + 2 // safety valve: real pagination must terminate well before this

  for (;;) {
    const { notifications, nextCursor } = await notificationRepository.list(
      userId,
      cursor === undefined ? { limit: 2 } : { limit: 2, cursor }
    )
    pageCount += 1
    expect(pageCount).toBeLessThanOrEqual(maxPages)
    expect(notifications.length).toBeLessThanOrEqual(2)

    for (const notification of notifications) {
      expect(seenIds.has(notification.id)).toBe(false) // no duplicates across pages
      seenIds.add(notification.id)
    }

    if (nextCursor === undefined) break
    const decoded = decodeNotificationCursor(nextCursor)
    expect(decoded).toBeDefined()
    cursor = decoded
  }

  return { seenIds, pageCount }
}

describe('NotificationRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user for a test to own notifications with, tracked for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  describe('create', () => {
    it('inserts a notification and returns the generated columns', async () => {
      const userId = await createUser()

      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'Click the link to verify your email address.',
        metadata: { templateKey: 'email_verification' },
      })

      expect(notification.id).toBeTruthy()
      expect(notification.userId).toBe(userId)
      expect(notification.type).toBe('verify_email')
      expect(notification.title).toBe('Verify your email')
      expect(notification.metadata).toEqual({ templateKey: 'email_verification' })
      expect(notification.readAt).toBeNull()
      expect(notification.createdAt).toBeInstanceOf(Date)
    })

    it('allows metadata to be omitted', async () => {
      const userId = await createUser()

      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'Click the link to verify your email address.',
      })

      expect(notification.metadata).toBeNull()
    })
  })

  describe('findByIdAndUser', () => {
    it('finds a notification owned by the given user', async () => {
      const userId = await createUser()
      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      const found = await notificationRepository.findByIdAndUser(notification.id, userId)
      expect(found?.id).toBe(notification.id)
    })

    it('returns undefined for an id that does not exist', async () => {
      const userId = await createUser()
      expect(await notificationRepository.findByIdAndUser(randomUUID(), userId)).toBeUndefined()
    })

    it('returns undefined when the notification belongs to a different user — the ownership check', async () => {
      const ownerId = await createUser()
      const otherUserId = await createUser()
      const notification = await notificationRepository.create({
        userId: ownerId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      expect(
        await notificationRepository.findByIdAndUser(notification.id, otherUserId)
      ).toBeUndefined()
    })
  })

  describe('markRead', () => {
    it('sets readAt on an unread notification owned by the given user', async () => {
      const userId = await createUser()
      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      const updated = await notificationRepository.markRead(notification.id, userId)
      expect(updated?.readAt).toBeInstanceOf(Date)
    })

    it('is a no-op returning undefined for an already-read notification', async () => {
      const userId = await createUser()
      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })
      const first = await notificationRepository.markRead(notification.id, userId)
      expect(first).toBeDefined()

      const second = await notificationRepository.markRead(notification.id, userId)
      expect(second).toBeUndefined()
    })

    it('does not mark a notification owned by a different user', async () => {
      const ownerId = await createUser()
      const otherUserId = await createUser()
      const notification = await notificationRepository.create({
        userId: ownerId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      expect(await notificationRepository.markRead(notification.id, otherUserId)).toBeUndefined()
      const reread = await notificationRepository.findByIdAndUser(notification.id, ownerId)
      expect(reread?.readAt).toBeNull()
    })
  })

  describe('markAllRead', () => {
    it('marks every unread notification for a user and returns the count', async () => {
      const userId = await createUser()
      for (let index = 0; index < 3; index += 1) {
        await notificationRepository.create({
          userId,
          type: 'verify_email',
          title: `Notification ${index}`,
          body: 'body',
        })
      }

      const count = await notificationRepository.markAllRead(userId)
      expect(count).toBe(3)

      const { notifications } = await notificationRepository.list(userId, { limit: 10 })
      expect(notifications.every((notification) => notification.readAt !== null)).toBe(true)
    })

    it('returns 0 when the user has no unread notifications', async () => {
      const userId = await createUser()
      expect(await notificationRepository.markAllRead(userId)).toBe(0)
    })

    it('does not mark another user’s notifications', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      const other = await notificationRepository.create({
        userId: otherUserId,
        type: 'verify_email',
        title: 'Not yours',
        body: 'body',
      })

      expect(await notificationRepository.markAllRead(userId)).toBe(0)
      const reread = await notificationRepository.findByIdAndUser(other.id, otherUserId)
      expect(reread?.readAt).toBeNull()
    })
  })

  describe('deleteOne', () => {
    it('deletes a notification owned by the given user and returns true', async () => {
      const userId = await createUser()
      const notification = await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      expect(await notificationRepository.deleteOne(notification.id, userId)).toBe(true)
      expect(await notificationRepository.findByIdAndUser(notification.id, userId)).toBeUndefined()
    })

    it('returns false for an id that does not exist', async () => {
      const userId = await createUser()
      expect(await notificationRepository.deleteOne(randomUUID(), userId)).toBe(false)
    })

    it('returns false, and does not delete, when the notification belongs to a different user', async () => {
      const ownerId = await createUser()
      const otherUserId = await createUser()
      const notification = await notificationRepository.create({
        userId: ownerId,
        type: 'verify_email',
        title: 'Verify your email',
        body: 'body',
      })

      expect(await notificationRepository.deleteOne(notification.id, otherUserId)).toBe(false)
      expect(await notificationRepository.findByIdAndUser(notification.id, ownerId)).toBeDefined()
    })
  })

  describe('list', () => {
    it('returns an empty page with no nextCursor for a user with no notifications', async () => {
      const userId = await createUser()
      const { notifications, nextCursor } = await notificationRepository.list(userId, {
        limit: 10,
      })
      expect(notifications).toEqual([])
      expect(nextCursor).toBeUndefined()
    })

    it('omits nextCursor once every row fits on one page', async () => {
      const userId = await createUser()
      await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'One',
        body: 'body',
      })
      await notificationRepository.create({
        userId,
        type: 'verify_email',
        title: 'Two',
        body: 'body',
      })

      const { notifications, nextCursor } = await notificationRepository.list(userId, {
        limit: 10,
      })
      expect(notifications).toHaveLength(2)
      expect(nextCursor).toBeUndefined()
    })

    it('does not return another user’s notifications', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await notificationRepository.create({
        userId: otherUserId,
        type: 'verify_email',
        title: 'Not yours',
        body: 'body',
      })

      const { notifications } = await notificationRepository.list(userId, { limit: 10 })
      expect(notifications).toEqual([])
    })

    // General-case regression: rows created one `create()` call at a time,
    // which in practice land at least a millisecond apart. This exercises
    // the ordinary `created_at < $cursor` branch of the keyset predicate,
    // not the `created_at = $cursor AND id < $id` tiebreaker branch — see
    // the test below for that.
    it('pages through every notification exactly once, with no gaps or duplicates', async () => {
      const userId = await createUser()
      const createdIds = new Set<string>()
      for (let index = 0; index < 9; index += 1) {
        const notification = await notificationRepository.create({
          userId,
          type: 'verify_email',
          title: `Notification ${index}`,
          body: 'body',
        })
        createdIds.add(notification.id)
      }

      const { seenIds } = await pageThroughAll(userId, createdIds)
      expect(seenIds).toEqual(createdIds) // no gaps: every created row was returned exactly once
    })

    // This is the actual load-bearing test for notification.model.ts's own
    // header comment: it argues `createdAt`'s millisecond precision is what
    // stops the cursor from silently skipping a row that shares a
    // millisecond with the cursor boundary. Rows created one at a time
    // (the test above) almost never land in the same millisecond, so that
    // argument was asserted in a comment but never actually exercised by a
    // test until now. `createdAt` is passed explicitly and identically for
    // every row — `NewNotification.createdAt` is optional (the column has
    // a database default) precisely because callers are allowed to set it,
    // and this is the one caller in this codebase that needs to — which
    // forces every comparison in the keyset predicate through the `id`
    // tiebreaker, the exact branch a same-millisecond burst would hit.
    it('pages through every notification exactly once, with no gaps or duplicates, when every row shares the same createdAt', async () => {
      const userId = await createUser()
      const sharedCreatedAt = new Date('2026-01-01T00:00:00.123Z')
      const createdIds = new Set<string>()
      for (let index = 0; index < 5; index += 1) {
        const notification = await notificationRepository.create({
          userId,
          type: 'verify_email',
          title: `Notification ${index}`,
          body: 'body',
          createdAt: sharedCreatedAt,
        })
        createdIds.add(notification.id)
      }

      const { seenIds, pageCount } = await pageThroughAll(userId, createdIds)
      expect(seenIds).toEqual(createdIds) // no gaps: every row was returned exactly once
      expect(pageCount).toBeGreaterThan(1) // proves pagination actually spanned multiple pages
    })
  })

  it('deletes a user’s notifications automatically via ON DELETE CASCADE', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    const notification = await notificationRepository.create({
      userId: user.id,
      type: 'verify_email',
      title: 'Verify your email',
      body: 'body',
    })

    await sql`delete from users where id = ${user.id}`
    // The user row is gone without ever being tracked in createdUserIds
    // above — afterEach has nothing to clean up here, deliberately, since
    // this test's own point is that the cascade already did it.

    const [row] = await sql`select * from notifications where id = ${notification.id}`
    expect(row).toBeUndefined()
  })
})
