// tests/unit/repositories/notification.repository.test.ts
//
// Pure-logic coverage only — no database. NotificationRepository's own
// methods all go straight to Postgres, so every behavioural test for them
// belongs in tests/integration/repositories/notification.repository.test.ts
// (this repo's own unit/integration split, CLAUDE.md — a test that reaches
// the real database must live under tests/integration/, never tests/unit/,
// regardless of what else is colocated there).
//
// What IS pure, and therefore testable here without Docker: the cursor
// encoding this file exports for NotificationRepository.list to use, and
// its inverse. encodeNotificationCursor/decodeNotificationCursor never
// touch db — they are exported specifically so a later task's controller
// can decode a client-supplied cursor string without hand-rolling
// base64url/JSON handling for a value only this repository produces.
import { describe, expect, it } from 'vitest'
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
} from '@/repositories/notification.repository'

describe('encodeNotificationCursor / decodeNotificationCursor', () => {
  it('round-trips a cursor through encode then decode unchanged', () => {
    const cursor = { createdAt: new Date('2026-01-15T10:30:00.123Z'), id: 'notif-1' }

    const decoded = decodeNotificationCursor(encodeNotificationCursor(cursor))

    expect(decoded?.id).toBe(cursor.id)
    expect(decoded?.createdAt.getTime()).toBe(cursor.createdAt.getTime())
  })

  it('preserves millisecond precision through the round trip', () => {
    // Not a round millisecond — proves the encoder doesn't accidentally
    // truncate to whole seconds the way a careless format string could.
    const cursor = { createdAt: new Date('2026-01-15T10:30:00.007Z'), id: 'notif-2' }

    const decoded = decodeNotificationCursor(encodeNotificationCursor(cursor))

    expect(decoded?.createdAt.getTime()).toBe(cursor.createdAt.getTime())
  })

  it('produces a URL-safe string with no base64 padding or reserved characters', () => {
    const encoded = encodeNotificationCursor({ createdAt: new Date(), id: 'notif-3' })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('decodes to undefined for a string that is not valid base64url JSON', () => {
    expect(decodeNotificationCursor('not-a-real-cursor!!!')).toBeUndefined()
  })

  it('decodes to undefined for well-formed JSON missing the expected fields', () => {
    const malformed = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url')
    expect(decodeNotificationCursor(malformed)).toBeUndefined()
  })

  it('decodes to undefined when createdAt is not a valid date string', () => {
    const malformed = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: 'notif-4' })
    ).toString('base64url')
    expect(decodeNotificationCursor(malformed)).toBeUndefined()
  })

  it('decodes to undefined for an empty string', () => {
    expect(decodeNotificationCursor('')).toBeUndefined()
  })
})
