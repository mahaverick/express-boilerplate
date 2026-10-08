/**
 * @file Pure-logic coverage only — no database. NotificationRepository's
 * own methods all go straight to Postgres, so every behavioural test
 * for them belongs in
 * tests/integration/repositories/notification.repository.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { encodeNotificationCursor } from '@/repositories/notification.repository'

/**
 * What is pure, and therefore testable here without Docker: the cursor
 * encoding this file exports for NotificationRepository.list to use. Its
 * decoding is `listNotificationsSchema`'s (tests/unit/validators).
 */
describe('encodeNotificationCursor', () => {
  it('produces a URL-safe string with no base64 padding or reserved characters', () => {
    const encoded = encodeNotificationCursor({ createdAt: new Date(), id: 'notif-3' })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
