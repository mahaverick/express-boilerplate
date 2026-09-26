// tests/unit/constants/auth.constants.test.ts
//
// The refresh cookie's name, path and domain per deployment. __Host- requires
// Secure, Path=/ and no Domain; __Secure- requires Secure. A plain name has no
// prefix rules, so COOKIE_DOMAIN still applies to it.
import { describe, expect, it } from 'vitest'
import { LEGACY_REFRESH_TOKEN_COOKIE_NAME, refreshCookieSpec } from '@/constants/auth.constants'

describe('refreshCookieSpec', () => {
  it('uses the plain name on the auth path when COOKIE_SECURE is false', () => {
    expect(refreshCookieSpec({ COOKIE_SECURE: false })).toStrictEqual({
      name: 'refreshToken',
      path: '/api/v1/auth',
    })
  })

  it('keeps COOKIE_DOMAIN on the plain name', () => {
    expect(refreshCookieSpec({ COOKIE_SECURE: false, COOKIE_DOMAIN: 'example.com' })).toStrictEqual(
      {
        name: 'refreshToken',
        path: '/api/v1/auth',
        domain: 'example.com',
      }
    )
  })

  it('uses __Host- on Path=/ with no domain when secure without COOKIE_DOMAIN', () => {
    expect(refreshCookieSpec({ COOKIE_SECURE: true, COOKIE_DOMAIN: undefined })).toStrictEqual({
      name: '__Host-refreshToken',
      path: '/',
    })
  })

  it('uses __Secure- on the auth path with COOKIE_DOMAIN when secure with a domain', () => {
    expect(refreshCookieSpec({ COOKIE_SECURE: true, COOKIE_DOMAIN: 'example.com' })).toStrictEqual({
      name: '__Secure-refreshToken',
      path: '/api/v1/auth',
      domain: 'example.com',
    })
  })

  it('keeps the legacy name', () => {
    expect(LEGACY_REFRESH_TOKEN_COOKIE_NAME).toBe('refreshToken')
  })
})
