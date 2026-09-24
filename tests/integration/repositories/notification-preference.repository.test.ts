// tests/integration/repositories/notification-preference.repository.test.ts
//
// Integration test against the real per-worker Postgres database (see
// tests/helpers/worker-database.ts). Every user this file creates is
// deleted in afterEach; notification_preferences.user_id carries ON DELETE
// CASCADE (notification.model.ts), so a preference row is never explicitly
// deleted here — the same cascade NotificationRepository's own integration
// test verifies once directly.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'

const preferenceRepository = new NotificationPreferenceRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `notification-pref-repo-${randomUUID()}@example.test`
}

describe('NotificationPreferenceRepository', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user for a test to hold preferences for, tracked for cleanup.
   * @returns The created user's id.
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
        emailEnabled: false,
        inAppEnabled: true,
      })

      expect(row.userId).toBe(userId)
      expect(row.notificationType).toBe('verify_email')
      expect(row.emailEnabled).toBe(false)
      expect(row.inAppEnabled).toBe(true)
    })

    it('updates the existing row in place on a second call for the same user and type', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: false,
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
        emailEnabled: false,
        inAppEnabled: false,
      })

      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: true,
      })

      const otherRows = await preferenceRepository.findByUser(otherUserId)
      expect(otherRows).toEqual([
        expect.objectContaining({ emailEnabled: false, inAppEnabled: false }),
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
        emailEnabled: false,
        inAppEnabled: true,
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
      // in-app is disabled here to prove isChannelEnabled reads the real
      // row for a channel that IS disableable — verify_email's email
      // channel (checked below) never reaches this branch at all.
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: true,
        inAppEnabled: false,
      })

      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'in_app')).toBe(
        false
      )
    })

    it('always returns true for verify_email’s email channel, even when a row disables it', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'verify_email', {
        emailEnabled: false,
        inAppEnabled: false,
      })

      // The one channel this repository refuses to ever report disabled —
      // a user who turned it off would lock themselves out of verifying
      // their own account. in_app, by contrast, honours the row above.
      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'email')).toBe(
        true
      )
      expect(await preferenceRepository.isChannelEnabled(userId, 'verify_email', 'in_app')).toBe(
        false
      )
    })

    it('always returns true for password_changed’s email channel, even when a row disables it', async () => {
      // Same non-disableable mechanism as verify_email above, but for a
      // different reason (notification-preference.repository.ts's
      // `NON_DISABLEABLE_EMAIL_TYPES` comment): this one locks nobody out —
      // it exists so an attacker who has taken over the account cannot
      // silence the one message that tells the real owner it happened.
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'password_changed', {
        emailEnabled: false,
        inAppEnabled: false,
      })

      expect(await preferenceRepository.isChannelEnabled(userId, 'password_changed', 'email')).toBe(
        true
      )
      expect(
        await preferenceRepository.isChannelEnabled(userId, 'password_changed', 'in_app')
      ).toBe(false)
    })

    it('always returns true for tenant_invitation’s email channel, even when a row disables it', async () => {
      const userId = await createUser()
      await preferenceRepository.upsert(userId, 'tenant_invitation', {
        emailEnabled: false,
        inAppEnabled: true,
      })

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
        emailEnabled: false,
        inAppEnabled: true,
      })

      const matrix = await preferenceRepository.getFullMatrix(userId)

      expect(matrix).toHaveLength(NOTIFICATION_TYPES.length)
      const verifyEmailEntry = matrix.find((entry) => entry.notificationType === 'verify_email')
      expect(verifyEmailEntry).toMatchObject({ emailEnabled: false, inAppEnabled: true })
    })
  })
})
