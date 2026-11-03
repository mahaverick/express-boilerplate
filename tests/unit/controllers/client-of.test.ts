/**
 * @file Unit tests for `clientOf`: which client a sign-in comes from and what
 * device name, if any, it stores. An invalid name never refuses the request.
 */
import type { Request } from 'express'
import { describe, expect, it } from 'vite-plus/test'
import { clientOf } from '@/controllers/helpers.controller'

/**
 * A request as `resolveClientKind` leaves it, carrying the given device name header.
 */
function requestFrom(kind: 'web' | 'native', deviceName?: string | string[]): Request {
  return {
    clientKind: kind,
    headers: deviceName === undefined ? {} : { 'x-device-name': deviceName },
  } as unknown as Request
}

describe('clientOf', () => {
  it('takes a valid device name on native', () => {
    expect(clientOf(requestFrom('native', 'iPhone 16'))).toEqual({
      kind: 'native',
      deviceName: 'iPhone 16',
    })
  })

  it('answers no device name on native when the header is absent', () => {
    expect(clientOf(requestFrom('native'))).toEqual({ kind: 'native', deviceName: null })
  })

  it('accepts a 64-character name and drops a 65-character one', () => {
    const at64 = 'a'.repeat(64)
    const at65 = 'a'.repeat(65)
    expect(clientOf(requestFrom('native', at64)).deviceName).toBe(at64)
    expect(clientOf(requestFrom('native', at65)).deviceName).toBeNull()
  })

  it.each([
    ['a control character', '\u0007x'],
    ['a line break', 'iPhone\n16'],
    ['a bidi override', 'iPhone‮16'],
    ['200 characters', 'a'.repeat(200)],
    ['an empty value', ''],
    ['only spaces', '   '],
    ['a repeated header', ['iPhone', 'iPad']],
  ])('drops a name with %s and does not throw', (_label, value) => {
    expect(clientOf(requestFrom('native', value))).toEqual({ kind: 'native', deviceName: null })
  })

  it('counts characters, so 64 emoji are accepted', () => {
    const emoji = '😀'.repeat(64)
    expect(clientOf(requestFrom('native', emoji)).deviceName).toBe(emoji)
  })

  it('ignores the header on web', () => {
    expect(clientOf(requestFrom('web', 'iPhone 16'))).toEqual({ kind: 'web', deviceName: null })
  })
})
