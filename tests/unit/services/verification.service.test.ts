import { describe, expect, it } from 'vitest'
import {
  buildInvitationAcceptUrl,
  buildPasswordResetUrl,
  buildVerificationUrl,
  frontendUrl,
} from '@/services/verification.service'

describe('buildVerificationUrl', () => {
  it('points at the frontend WEB_URL, not the API', () => {
    // The base is passed explicitly in every test here: this is a unit test — it must not depend on a validated env being loadable, and getEnv() throws when one is not.
    const url = new URL(buildVerificationUrl('abc123', 'https://app.example.com'))

    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/verify-email')
    expect(url.searchParams.get('token')).toBe('abc123')
  })

  it('percent-encodes the token rather than concatenating it raw', () => {
    // Tokens are hex (session.service.ts generateRawToken), so nothing needs escaping today — this pins the behaviour anyway: a future encoding whose alphabet includes '+' or '/' would otherwise silently decode to something else in a query string, breaking a verification link for a fraction of users with no error anywhere.
    const url = new URL(buildVerificationUrl('a+b/c==', 'https://app.example.com'))

    expect(url.searchParams.get('token')).toBe('a+b/c==')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    // A cloner's .env is as likely to say https://app.example.com/ as https://app.example.com, and //verify-email 404s on most routers.
    expect(buildVerificationUrl('t', 'https://app.example.com/')).toBe(
      'https://app.example.com/verify-email?token=t'
    )
  })
})

describe('buildPasswordResetUrl', () => {
  it('points at the frontend WEB_URL, not the API', () => {
    const url = new URL(buildPasswordResetUrl('abc123', 'https://app.example.com'))

    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/reset-password')
    expect(url.searchParams.get('token')).toBe('abc123')
  })

  it('percent-encodes the token rather than concatenating it raw', () => {
    const url = new URL(buildPasswordResetUrl('a+b/c==', 'https://app.example.com'))

    expect(url.searchParams.get('token')).toBe('a+b/c==')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    expect(buildPasswordResetUrl('t', 'https://app.example.com/')).toBe(
      'https://app.example.com/reset-password?token=t'
    )
  })
})

describe('buildInvitationAcceptUrl', () => {
  it('points at the frontend accept page with the token as a query parameter', () => {
    const url = new URL(buildInvitationAcceptUrl('abc_123-XYZ', 'https://app.example.com'))

    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/invitations/accept')
    expect(url.searchParams.get('token')).toBe('abc_123-XYZ')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    expect(buildInvitationAcceptUrl('t', 'https://app.example.com/')).toBe(
      'https://app.example.com/invitations/accept?token=t'
    )
  })
})

describe('frontendUrl', () => {
  const web = 'https://app.example.com'
  const apex = 'https://admin.example.com'

  it('answers WEB_URL for web, whether or not APEX_URL is set', () => {
    expect(frontendUrl('web', { WEB_URL: web, APEX_URL: undefined })).toBe(web)
    expect(frontendUrl('web', { WEB_URL: web, APEX_URL: apex })).toBe(web)
  })

  it('answers APEX_URL for apex when it is set', () => {
    expect(frontendUrl('apex', { WEB_URL: web, APEX_URL: apex })).toBe(apex)
  })

  it('falls back to WEB_URL for apex when APEX_URL is unset', () => {
    expect(frontendUrl('apex', { WEB_URL: web, APEX_URL: undefined })).toBe(web)
  })

  it.each([
    ['https://admin.example.com/', 'https://admin.example.com/reset-password?token=t'],
    ['https://admin.example.com/apex', 'https://admin.example.com/apex/reset-password?token=t'],
    ['https://admin.example.com/apex/', 'https://admin.example.com/apex/reset-password?token=t'],
  ])('builds a clean link from APEX_URL %s', (configured, expected) => {
    const base = frontendUrl('apex', { WEB_URL: web, APEX_URL: configured })
    expect(buildPasswordResetUrl('t', base)).toBe(expected)
  })
})
