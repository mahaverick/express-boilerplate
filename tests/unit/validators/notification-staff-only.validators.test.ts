/**
 * @file The preferences update schema's two guards on their own: a staff-only
 * type is refused for a caller with no platform role and accepted for staff,
 * and `emailEnabled: false` is refused for every notification type however
 * the body is crafted (the schema is the only gate before `upsert`).
 */
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '@/constants/notification.constants'
import { updatePreferencesSchemaFor } from '@/validators/notification.validators'

const EMAIL_OFF_MESSAGE = 'Email for this notification type cannot be turned off.'

/**
 * One preferences entry.
 * @param notificationType - The type.
 * @param isEmailOn - The email toggle.
 * @param isInAppOn - The in-app toggle.
 */
function entry(notificationType: string, isEmailOn: boolean, isInAppOn: boolean) {
  return { notificationType, emailEnabled: isEmailOn, inAppEnabled: isInAppOn }
}

describe('updatePreferencesSchemaFor staff-only visibility', () => {
  const body = { preferences: [entry('maintenance_mode_changed', true, false)] }

  it('refuses a staff-only type for a caller with no platform role', () => {
    const result = updatePreferencesSchemaFor(false).safeParse(body)
    expect(result.success).toBe(false)
  })

  it('accepts it for platform staff', () => {
    expect(updatePreferencesSchemaFor(true).safeParse(body).success).toBe(true)
  })
})

describe('updatePreferencesSchemaFor in-app toggles', () => {
  it.each(NOTIFICATION_TYPES)('accepts inAppEnabled false for %s (staff)', (type) => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [entry(type, true, false)],
    })
    expect(result.success).toBe(true)
  })
})

describe('updatePreferencesSchemaFor never admits emailEnabled false', () => {
  it.each(NOTIFICATION_TYPES)('refuses emailEnabled false for %s with a field message', (type) => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [entry(type, false, true)],
    })
    expect(result.success).toBe(false)
    const issue = result.error?.issues[0]
    expect(issue?.path).toEqual(['preferences', 0, 'emailEnabled'])
    expect(issue?.message).toBe(EMAIL_OFF_MESSAGE)
  })

  it('refuses a body that mixes a valid entry with an email-off one', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [entry('verify_email', true, false), entry('password_changed', false, true)],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues).toHaveLength(1)
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 1, 'emailEnabled'])
    expect(result.error?.issues[0]?.message).toBe(EMAIL_OFF_MESSAGE)
  })

  it('refuses a type listed twice, even when only the second entry turns email off', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [entry('verify_email', true, true), entry('verify_email', false, true)],
    })
    expect(result.success).toBe(false)
    const issues = result.error?.issues ?? []
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        ['preferences', 1, 'emailEnabled'],
        ['preferences', 1, 'notificationType'],
      ])
    )
  })

  it('refuses a type listed twice with both entries valid, so one request never races two upserts', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [entry('verify_email', true, true), entry('verify_email', true, false)],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 1, 'notificationType'])
  })

  it('does not let an extra key smuggle a disabled email channel through', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [{ ...entry('verify_email', true, true), emailEnabled_: false, email: false }],
    })
    expect(result.success).toBe(true)
    expect(result.data?.preferences[0]).toEqual(entry('verify_email', true, true))
  })

  it.each([undefined, 'false', 0])('refuses a non-boolean emailEnabled (%s)', (value) => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: [{ notificationType: 'verify_email', emailEnabled: value, inAppEnabled: true }],
    })
    expect(result.success).toBe(false)
  })
})

describe('updatePreferencesSchemaFor entry count', () => {
  it('refuses more entries than there are notification types', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: Array.from({ length: NOTIFICATION_TYPES.length + 1 }, () =>
        entry('verify_email', true, true)
      ),
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      `preferences must contain at most ${NOTIFICATION_TYPES.length} entries.`
    )
  })

  it('accepts one entry per type', () => {
    const result = updatePreferencesSchemaFor(true).safeParse({
      preferences: NOTIFICATION_TYPES.map((type) => entry(type, true, false)),
    })
    expect(result.success).toBe(true)
  })
})
