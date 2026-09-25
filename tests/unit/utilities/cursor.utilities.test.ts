// tests/unit/utilities/cursor.utilities.test.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { decodeCursor, encodeCursor } from '@/utilities/cursor.utilities'

const schema = z.object({ sortName: z.string(), id: z.string() }).strict()

describe('cursor utilities', () => {
  it('round-trips a value through an opaque base64url string', () => {
    const raw = encodeCursor({ sortName: 'acme', id: 'id-1' })
    expect(raw).toMatch(/^[\w-]+$/)
    expect(decodeCursor(raw, schema)).toEqual({ sortName: 'acme', id: 'id-1' })
  })

  it.each([
    ['not base64 JSON', '!!!'],
    ['JSON of the wrong shape', Buffer.from('{"sortName":1}').toString('base64url')],
    ['an extra key', Buffer.from('{"sortName":"a","id":"b","x":1}').toString('base64url')],
  ])('answers undefined for %s', (_label, raw) => {
    expect(decodeCursor(raw, schema)).toBeUndefined()
  })
})
