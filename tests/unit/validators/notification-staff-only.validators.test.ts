/**
 * @file The update schema's staff-only guard on its own: with a staff-only
 * type that is also configurable (none is today, so the constants are
 * mocked), the schema must refuse it for a caller with no platform role and
 * accept it for staff. Without this, the empty configurable list would hide
 * a missing visibility check.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/constants/notification.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants/notification.constants')>()
  return {
    ...actual,
    NOTIFICATION_TYPES: [...actual.NOTIFICATION_TYPES, 'staff_digest'] as const,
    STAFF_ONLY_NOTIFICATION_TYPES: ['staff_digest'] as const,
  }
})

const { updatePreferencesSchemaFor } = await import('@/validators/notification.validators')

const BODY = {
  preferences: [{ notificationType: 'staff_digest', emailEnabled: false, inAppEnabled: true }],
}

describe('updatePreferencesSchemaFor with a configurable staff-only type', () => {
  it('refuses it for a caller with no platform role', () => {
    expect(updatePreferencesSchemaFor(false).safeParse(BODY).success).toBe(false)
  })

  it('accepts it for platform staff', () => {
    expect(updatePreferencesSchemaFor(true).safeParse(BODY).success).toBe(true)
  })
})
