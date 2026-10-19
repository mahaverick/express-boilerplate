/**
 * @file `decodeIdTokenClaims`: reads the payload of an ID token Google's
 * token endpoint returned, with no signature check, and refuses anything
 * that is not a three-part JWT whose payload carries the claims step-up
 * reads.
 */
import { describe, expect, it } from 'vitest'
import { decodeIdTokenClaims } from '@/utilities/id-token.utilities'

/**
 * A three-part token whose payload segment is `payload`, base64url-encoded.
 * @param payload - The payload text, JSON or not.
 * @returns `header.payload.signature`.
 */
function tokenWithPayload(payload: string): string {
  const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')
  return `${header}.${Buffer.from(payload).toString('base64url')}.c2lnbmF0dXJl`
}

const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: 'client-id',
  sub: '1234567890',
  exp: 2_000_000_000,
  auth_time: 1_900_000_000,
}

describe('decodeIdTokenClaims', () => {
  it('decodes the payload of a three-part JWT', () => {
    const token = tokenWithPayload(JSON.stringify(CLAIMS))

    expect(decodeIdTokenClaims(token)).toEqual(CLAIMS)
  })

  it('leaves auth_time out when the token carries none', () => {
    const withoutAuthTime = { iss: CLAIMS.iss, aud: CLAIMS.aud, sub: CLAIMS.sub, exp: CLAIMS.exp }
    const token = tokenWithPayload(JSON.stringify(withoutAuthTime))

    expect(decodeIdTokenClaims(token)).toEqual(withoutAuthTime)
  })

  it.each([
    ['no dots', 'abc'],
    ['two parts', 'a.b'],
    ['four parts', 'a.b.c.d'],
    ['an empty payload', 'a..c'],
  ])('throws on a token without three parts: %s', (_label, token) => {
    expect(() => decodeIdTokenClaims(token)).toThrow()
  })

  it('throws on a token with a non-JSON payload', () => {
    expect(() => decodeIdTokenClaims(tokenWithPayload('not json'))).toThrow()
  })

  it.each([
    ['a JSON array', '[]'],
    ['a missing sub', JSON.stringify({ ...CLAIMS, sub: undefined })],
    ['an audience list', JSON.stringify({ ...CLAIMS, aud: ['client-id'] })],
    ['a string auth_time', JSON.stringify({ ...CLAIMS, auth_time: '1900000000' })],
  ])('throws on a payload without the claims step-up reads: %s', (_label, payload) => {
    expect(() => decodeIdTokenClaims(tokenWithPayload(payload))).toThrow()
  })
})
