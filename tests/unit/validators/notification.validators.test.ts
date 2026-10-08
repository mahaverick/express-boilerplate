import { describe, expect, it } from 'vitest'
import { encodeNotificationCursor } from '@/repositories/notification.repository'
import { listNotificationsSchema } from '@/validators/notification.validators'

const ID = '01a1156d-00b7-75d4-887f-2dd37e110303'

/**
 * Encode arbitrary JSON the way a cursor travels.
 * @param value - The decoded cursor.
 * @returns The base64url cursor.
 */
function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('listNotificationsSchema cursor', () => {
  it('round-trips a cursor the repository issued, to the millisecond', () => {
    const createdAt = new Date('2026-01-15T10:30:00.007Z')
    const parsed = listNotificationsSchema.parse({
      cursor: encodeNotificationCursor({ createdAt, id: ID }),
    })

    expect(parsed.cursor).toEqual({ createdAt: '2026-01-15T10:30:00.007Z', id: ID })
    expect(new Date(parsed.cursor?.createdAt ?? '').getTime()).toBe(createdAt.getTime())
  })

  it('accepts the earliest instant Postgres holds, year 0001', () => {
    const parsed = listNotificationsSchema.parse({
      cursor: b64({ createdAt: '0001-01-01T00:00:00.000Z', id: ID }),
    })
    expect(parsed.cursor?.createdAt).toBe('0001-01-01T00:00:00.000Z')
  })

  it('leaves the cursor out when none is sent', () => {
    expect(listNotificationsSchema.parse({}).cursor).toBeUndefined()
  })

  it.each([
    ['not base64url JSON', 'not-a-real-cursor!!!'],
    ['an empty string', ''],
    ['JSON missing the fields', b64({ foo: 'bar' })],
    ['a createdAt that is not a date', b64({ createdAt: 'not-a-date', id: ID })],
    ['an extra field', b64({ createdAt: '2026-01-15T10:30:00.007Z', id: ID, userId: ID })],
    ['year zero, which Postgres cannot hold', b64({ createdAt: '0000-01-01T00:00:00Z', id: ID })],
    ['an offset instead of Z', b64({ createdAt: '2026-01-15T10:30:00+02:00', id: ID })],
  ])('refuses %s with "cursor is invalid."', (_label, cursor) => {
    const result = listNotificationsSchema.safeParse({ cursor })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain('cursor is invalid.')
  })
})
