import { describe, expect, it } from 'vitest'
import { buildVerificationUrl } from '@/utilities/verification-link.utilities'

describe('buildVerificationUrl', () => {
  it('points at the frontend WEB_URL, not the API', () => {
    // The base is passed explicitly in every test here. This is a unit
    // test — it must not depend on a validated env being loadable, and
    // getEnv() throws when one is not.
    const url = new URL(buildVerificationUrl('abc123', 'https://app.example.com'))

    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/verify-email')
    expect(url.searchParams.get('token')).toBe('abc123')
  })

  it('percent-encodes the token rather than concatenating it raw', () => {
    // Tokens are hex today (token.utilities.ts:116), so nothing needs
    // escaping yet. This pins the behaviour anyway: the day the encoding
    // changes, a '+' or '/' in a query string silently decodes to
    // something else, and a verification link stops working for a
    // fraction of users with no error anywhere.
    const url = new URL(buildVerificationUrl('a+b/c==', 'https://app.example.com'))

    expect(url.searchParams.get('token')).toBe('a+b/c==')
  })

  it('does not double a slash when WEB_URL has a trailing one', () => {
    // A cloner's .env is as likely to say https://app.example.com/ as
    // https://app.example.com, and //verify-email 404s on most routers.
    expect(buildVerificationUrl('t', 'https://app.example.com/')).toBe(
      'https://app.example.com/verify-email?token=t'
    )
  })
})
