/**
 * @file Integration test against the real per-worker Postgres database (see
 * `tests/helpers/worker-database.ts`). Every user this file creates is
 * deleted in `afterEach`; `notification_preferences.user_id` carries `ON
 * DELETE CASCADE` (`notification.model.ts`), so a preference row is never
 * explicitly deleted here. `notification.repository.test.ts` verifies the
 * same cascade directly for `notifications.user_id`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const preferenceRepository = new NotificationPreferenceRepository()
const userRepository = new UserRepository()

/**
 * A disposable email unique to this call, so it cannot collide with rows other tests in this
 * worker's database hold.
 */
function uniqueEmail(): string {
  return `notification-pref-repo-${randomUUID()}@example.test`
}

/**
 * Insert a preference row directly, bypassing the repository's `upsert` guard, to stand for a row
 * written before that guard existed.
 * @param userId - The user.
 * @param notificationType - The type.
 * @param isEmailOn - The stored email flag.
 * @param isInAppOn - The stored in-app flag.
 */
async function seedRow(
  userId: string,
  notificationType: string,
  isEmailOn: boolean,
  isInAppOn: boolean
): Promise<void> {
  await sql`insert into notification_preferences (user_id, notification_type, email_enabled, in_app_enabled) values (${userId}, ${notificationType}, ${isEmailOn}, ${isInAppOn})`
}

describe('NotificationPreferenceRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Creates a user for a test to hold preferences, tracked for cleanup.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  describe('upsert', () => {
    it('creates a preference row when none exists', async () => {
      const userId = await createUser()

      const row = await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      expect(row.userId).toBe(userId)
      expect(row.notificationType).toBe('verify_email')
      expect(row.emailEnabled).toBe(true)
      expect(row.inAppEnabled).toBe(false)
    })

    it.each(NOTIFICATION_TYPES)(
      'refuses emailEnabled false for %s with a 400 and writes nothing',
      async (type) => {
        const userId = await createUser()

        await expect(
          preferenceRepository.upsert(userId, type, { emailEnabled: false, inAppEnabled: true })
        ).rejects.toMatchObject({
          statusCode: 400,
          message: 'Email for this notification type cannot be turned off.',
        })

        expect(await preferenceRepository.findByUser(userId)).toEqual([])
      }
    )

    it('leaves an existing row unchanged when a later upsert is refused', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      await expect(
        preferenceRepository.upsert(userId, 'verify_email', {
          emailEnabled: false,
          inAppEnabled: true,
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(await preferenceRepository.findByUser(userId)).toEqual([
        expect.objectContaining({ emailEnabled: true, inAppEnabled: false }),
      ])
    })

    it('updates the existing row in place on a second call for the same user and type', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: true,
      })

      const updated = await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      expect(updated.emailEnabled).toBe(true)
      expect(updated.inAppEnabled).toBe(false)

      const rows = await preferenceRepository.findByUser(userId)
      expect(rows).toHaveLength(1) // proves it updated the same row rather than inserting a second
    })

    it('does not affect another user’s preference row for the same notification type', async () => {
      const userId = await createUser()
      const otherUserId = await createUser()
      await preferenceRepository.upsert(otherUserId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: true,
      })

      const otherRows = await preferenceRepository.findByUser(otherUserId)
      expect(otherRows).toEqual([
        expect.objectContaining({ emailEnabled: true, inAppEnabled: false }),
      ])
    })
  })

  describe('findByUser', () => {
    it('returns an empty array for a user with no explicit preferences', async () => {
      const userId = await createUser()
      expect(await preferenceRepository.findByUser(userId)).toEqual([])
    })

    it('returns only the rows this user explicitly set', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      const rows = await preferenceRepository.findByUser(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.notificationType).toBe('verify_email')
    })
  })

  describe('isChannelEnabled', () => {
    it('returns true for both channels when no row exists — the opt-out default', async () => {
      const userId = await createUser()

      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'email')).toBe(
        true
      )
      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'in_app')).toBe(
        true
      )
    })

    it('reflects an explicit row once one exists', async () => {
      const userId = await createUser()
      // in-app is disabled here to prove isChannelEnabled reads the real row for a channel that is disableable — verify_email's email channel never reaches this branch at all.
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'in_app')).toBe(
        false
      )
    })

    it('always returns true for verify_email’s email channel, even when a legacy row disables it', async () => {
      const userId = await createUser()
      await seedRow(userId, 'verify_email', false, false)

      // This repository never reports this channel disabled: a user who turned it off would lock themselves out of verifying their own account. in_app, by contrast, honours the row above.
      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'email')).toBe(
        true
      )
      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'in_app')).toBe(
        false
      )
    })

    it('always returns true for password_changed’s email channel, even when a legacy row disables it', async () => {
      // Same NON_DISABLEABLE_EMAIL_TYPES mechanism as verify_email above, but this one locks nobody out: it exists so an attacker who took over the account cannot silence the message that tells the real owner it happened.
      const userId = await createUser()
      await seedRow(userId, 'password_changed', false, false)

      expect(await preferenceRepository.isChannelEnabled(userId, 'password_changed', 'email')).toBe(
        true
      )
      expect(
        await preferenceRepository.isChannelEnabled(userId, 'password_changed', 'in_app')
      ).toBe(false)
    })

    it('always returns true for tenant_invitation’s email channel, even when a legacy row disables it', async () => {
      const userId = await createUser()
      await seedRow(userId, 'tenant_invitation', false, true)

      expect(
        await preferenceRepository.isChannelEnabled(userId, 'tenant_invitation', 'email')
      ).toBe(true)
    })
  })

  describe('getFullMatrix', () => {
    it('returns every known notification type, defaulted to both channels enabled, for a user with no rows', async () => {
      const userId = await createUser()

      const matrix = await preferenceRepository.getFullMatrix(userId)

      expect(matrix).toHaveLength(NOTIFICATION_TYPES.length)
      for (const entry of matrix) {
        expect(entry.emailEnabled).toBe(true)
        expect(entry.inAppEnabled).toBe(true)
      }
      expect(
        matrix.map((entry) => entry.notificationType).toSorted((a, b) => a.localeCompare(b))
      ).toEqual([...NOTIFICATION_TYPES].toSorted((a, b) => a.localeCompare(b)))
    })

    it('fills in an explicit row for the type it exists for, and defaults for every other type', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      const matrix = await preferenceRepository.getFullMatrix(userId)

      expect(matrix).toHaveLength(NOTIFICATION_TYPES.length)
      const verifyEmailEntry = matrix.find((entry) => entry.notificationType === 'verify_email')
      expect(verifyEmailEntry).toMatchObject({ emailEnabled: true, inAppEnabled: false })
    })
  })
})
