/**
 * @file stepUpAuthTimeFrom: reads `auth_time` from the ID token in Google's
 * token response, only when the token names this client, Google, and the
 * profile it came with. Pure: tokens are built here, unsigned.
 */
import { describe, expect, it } from 'vitest'
import { stepUpAuthTimeFrom } from '@/utilities/google-id-token.utilities'

const CLIENT_ID = 'client-id.apps.googleusercontent.com'
const PROFILE_ID = '1234567890'

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * An unsigned JWT with the given claims: the header and signature are never read.
 * @param claims - The payload.
 * @returns The compact token.
 */
function idToken(claims: Record<string, unknown>): string {
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`
}

const valid = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: PROFILE_ID,
  auth_time: 1_700_000_000,
}

describe('stepUpAuthTimeFrom', () => {
  it('returns auth_time from a token for this client, Google and this profile', () => {
    expect(stepUpAuthTimeFrom({ id_token: idToken(valid) }, PROFILE_ID, CLIENT_ID)).toBe(
      1_700_000_000
    )
  })

  it('accepts the bare accounts.google.com issuer Google also uses', () => {
    const token = idToken({ ...valid, iss: 'accounts.google.com' })
    expect(stepUpAuthTimeFrom({ id_token: token }, PROFILE_ID, CLIENT_ID)).toBe(1_700_000_000)
  })

  it.each([
    ['another client', { ...valid, aud: 'someone-else' }],
    ['another issuer', { ...valid, iss: 'https://evil.example' }],
    ['another subject', { ...valid, sub: '999' }],
    ['no auth_time', { iss: valid.iss, aud: valid.aud, sub: valid.sub }],
    ['a string auth_time', { ...valid, auth_time: '1700000000' }],
  ])('returns undefined for a token with %s', (_label, claims) => {
    expect(stepUpAuthTimeFrom({ id_token: idToken(claims) }, PROFILE_ID, CLIENT_ID)).toBeUndefined()
  })

  it.each([
    ['no params', undefined],
    ['no id_token', { access_token: 'x' }],
    ['a token that is not a JWT', { id_token: 'garbage' }],
    ['a payload that is not JSON', { id_token: 'a.bm90LWpzb24.c' }],
  ])('returns undefined for %s', (_label, parameters) => {
    expect(stepUpAuthTimeFrom(parameters, PROFILE_ID, CLIENT_ID)).toBeUndefined()
  })
})
