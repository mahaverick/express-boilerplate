/**
 * @file Integration test against the real per-worker Postgres database (see
 * `tests/helpers/worker-database.ts`). Every user this file creates is
 * deleted in `afterEach` — deleting the user is enough: `notifications.user_id`
 * carries `ON DELETE CASCADE` (`notification.model.ts`), so a row this file
 * never explicitly deletes is gone once its owning user is. One
 * cascade test below asserts that property directly rather than leaving it
 * an unverified assumption.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { NotificationRepository } from '@/repositories/notification.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { notificationListSchema } from '@/validators/notification.validators'

const notificationRepository = new NotificationRepository()

/**
 * The params of a first page of ten with the default sort.
 */
const TEN = notificationListSchema.parse({ limit: '10' }).params

/**
 * No `unread` filter.
 */
const NO_FILTERS = { unread: undefined }
const userRepository = new UserRepository()

/**
 * A disposable email unique to this call, so it cannot collide with rows other tests in this
 * worker's database hold.
 */
function uniqueEmail(): string {
  return `notification-repo-${randomUUID()}@example.test`
}

/**
 * Pages through a user's whole inbox two rows at a time, following the real `nextCursor`, and
 * reports the ids seen and the page count. Both pagination tests use it; they differ only in how
 * `createdAt` was assigned. `expectedIds` only sizes the page limit that stops a cursor that
 * never ends.
 */
async function pageThroughAll(
  userId: string,
  expectedIds: Set<string>
): Promise<{ seenIds: Set<string>; pageCount: number }> {
  const seenIds = new Set<string>()
  let cursor: string | null | undefined
  let pageCount = 0
  const maxPages = expectedIds.size + 2 // safety valve: real pagination must terminate well before this

  do {
    const { params } = notificationListSchema.parse(
      typeof cursor === 'string' ? { limit: '2', cursor } : { limit: '2' }
    )
    const { items, page } = await notificationRepository.list(userId, params, { unread: undefined })
    pageCount += 1
    expect(pageCount).toBeLessThanOrEqual(maxPages)
    expect(items.length).toBeLessThanOrEqual(2)

    for (const notification of items) {
      expect(seenIds.has(notification.id)).toBe(false) // no duplicates across pages
      seenIds.add(notification.id)
    }

    cursor = page.nextCursor
  } while (typeof cursor === 'string')

  return { seenIds, pageCount }
}

describe('NotificationRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  it('createOnce inserts once per dedupe key and returns undefined for the repeat', async () => {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    const data = {
      userId: user.id,
      type: 'verify_email' as const,
      title: 'Verify your email',
      body: 'body',
      dedupeKey: `notification-job-${randomUUID()}-1`,
    }

    const first = await notificationRepository.createOnce(data)
    const second = await notificationRepository.createOnce(data)

    expect(first?.dedupeKey).toBe(data.dedupeKey)
    expect(second).toBeUndefined()
    const notifications = await notificationRepository.listRecent(user.id, 10)
    expect(notifications).toHaveLength(1)
  })

  /**
   * Creates a user for a test to own notifications, tracked for cleanup.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * Seeds a user's four notifications at distinct instants: two unread
   * (one mentioning "invoice" in the body), two read (one mentioning it in the title).
   */
  async function seedInbox(): Promise<string> {
    const userId = await createUser()
    const read = new Date(Date.UTC(2026, 1, 1)).toISOString()
    await sql`insert into notifications (user_id, type, title, body, read_at, created_at) values
      (${userId}, 'password_changed', 'first', 'plain', ${read}, ${new Date(Date.UTC(2026, 0, 1)).toISOString()}),
      (${userId}, 'password_changed', 'Invoice paid', 'plain', ${read}, ${new Date(Date.UTC(2026, 0, 2)).toISOString()}),
      (${userId}, 'password_changed', 'third', 'unpaid invoice', NULL, ${new Date(Date.UTC(2026, 0, 3)).toISOString()}),
      (${userId}, 'password_changed', 'fourth', 'plain', NULL, ${new Date(Date.UTC(2026, 0, 4)).toISOString()})`
    return userId
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

      const notifications = await notificationRepository.listRecent(userId, 10)
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
      const { items, page } = await notificationRepository.list(userId, TEN, NO_FILTERS)
      expect(items).toEqual([])
      expect(page.hasNext).toBe(false)
      expect(page.nextCursor).toBeNull()
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

      const { items, page } = await notificationRepository.list(userId, TEN, NO_FILTERS)
      expect(items).toHaveLength(2)
      expect(page.hasNext).toBe(false)
      expect(page.nextCursor).toBeNull()
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

      const { items } = await notificationRepository.list(userId, TEN, NO_FILTERS)
      expect(items).toEqual([])
    })

    /**
     * Rows created one `create()` call at a time normally get distinct
     * `createdAt` values, so this exercises the ordinary `created_at < $cursor`
     * branch, not the `created_at = $cursor AND id < $id` tiebreaker (see the
     * test below for that).
     */
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

    /**
     * `createdAt`'s millisecond precision (`notification.model.ts`) lets the
     * cursor round-trip through a JS `Date` exactly. `createdAt` is passed
     * explicitly and identically for every row here, so every comparison in the
     * keyset predicate goes through the `id` tiebreaker, the branch a
     * same-millisecond burst hits, and a row sharing the cursor's millisecond
     * must not be skipped.
     */
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
      expect(seenIds).toEqual(createdIds) // no gaps: every row was returned exactly once, and pagination spanned multiple pages
      expect(pageCount).toBeGreaterThan(1)
    })
  })

  describe('listRecent', () => {
    it('reads the newest notifications first, at most limit, and only the owner’s', async () => {
      const user = await userRepository.create({ email: uniqueEmail() })
      const other = await userRepository.create({ email: uniqueEmail() })
      createdUserIds.push(user.id, other.id)
      await sql`insert into notifications (user_id, type, title, body, created_at) values
        (${user.id}, 'password_changed', 'oldest', 'b', ${new Date(Date.UTC(2026, 0, 1)).toISOString()}),
        (${user.id}, 'password_changed', 'middle', 'b', ${new Date(Date.UTC(2026, 0, 2)).toISOString()}),
        (${user.id}, 'password_changed', 'newest', 'b', ${new Date(Date.UTC(2026, 0, 3)).toISOString()}),
        (${other.id}, 'password_changed', 'not mine', 'b', ${new Date(Date.UTC(2026, 0, 4)).toISOString()})`

      const recent = await notificationRepository.listRecent(user.id, 2)

      expect(recent.map((notification) => notification.title)).toEqual(['newest', 'middle'])
    })
  })

  describe('list over real rows', () => {
    it('reads newest first by default, without the internal columns', async () => {
      const userId = await seedInbox()

      const { items } = await notificationRepository.list(userId, TEN, NO_FILTERS)

      expect(items.map((item) => item.title)).toEqual(['fourth', 'third', 'Invoice paid', 'first'])
      expect(Object.keys(items[0] ?? {})).not.toContain('dedupeKey')
      expect(Object.keys(items[0] ?? {})).not.toContain('sortCreated')
    })

    it('narrows to unread, and to read, ones', async () => {
      const userId = await seedInbox()

      const unread = await notificationRepository.list(userId, TEN, { unread: true })
      const read = await notificationRepository.list(userId, TEN, { unread: false })

      expect(unread.items.map((item) => item.title)).toEqual(['fourth', 'third'])
      expect(read.items.map((item) => item.title)).toEqual(['Invoice paid', 'first'])
    })

    it('combines the unread filter with a case-insensitive search of title and body', async () => {
      const userId = await seedInbox()
      const { params } = notificationListSchema.parse({ search: 'INVOICE', limit: '10' })

      const both = await notificationRepository.list(userId, params, NO_FILTERS)
      const unread = await notificationRepository.list(userId, params, { unread: true })
      const read = await notificationRepository.list(userId, params, { unread: false })

      expect(both.items.map((item) => item.title)).toEqual(['third', 'Invoice paid'])
      expect(unread.items.map((item) => item.title)).toEqual(['third'])
      expect(read.items.map((item) => item.title)).toEqual(['Invoice paid'])
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
    // Deliberately never tracked in createdUserIds: this test's own point is that the cascade already did the cleanup.

    const [row] = await sql`select * from notifications where id = ${notification.id}`
    expect(row).toBeUndefined()
  })
})
