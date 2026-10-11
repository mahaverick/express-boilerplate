/**
 * @file `verifyAccessToken`, the claims `signAccessToken` signs and
 * `hashToken`, with no database and no user row: a hand-built `{ id }` stands
 * in for the user. The test that signs for a real created user is in
 * tests/integration/services/session.service.test.ts.
 */
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import { hashToken, signAccessToken, verifyAccessToken } from '@/services/session.service'

/**
 * verifyAccessToken returns a discriminated result rather than throwing
 * (VerifyAccessTokenResult, session.service.ts). Every case below asserts the
 * full `{ ok: false, reason }` via toEqual, because only the whole object
 * proves both "rejected" and "rejected for the right reason".
 */
describe('verifyAccessToken', () => {
  it('rejects a token signed with the wrong secret', () => {
    const wrongKey = 'a-completely-different-signing-value-32-chars'
    const token = jwt.sign({ sub: 'someone' }, wrongKey, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects an expired access token, distinguishing it from other rejections', () => {
    const token = jwt.sign({ sub: 'someone' }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Expired when signed: a negative `expiresIn` puts `exp` in the past.
      expiresIn: -10,
    })

    // 'expired' specifically, not just "rejected": a caller (auth.middleware.ts) tells "refresh me" apart from "log in again", and jsonwebtoken raises TokenExpiredError only after the signature has verified.
    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token signed with a different algorithm than HS256 expects', () => {
    // 'none' with an empty signature is the classic alg-confusion probe; pinning `algorithms: ['HS256']` on verify is what stops it. This must resolve 'invalid', not 'expired': the token is rejected before any claim is read, and its payload has no `exp`.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'someone' })).toString('base64url')
    const forged = `${header}.${payload}.`

    expect(verifyAccessToken(forged)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a malformed token string', () => {
    expect(verifyAccessToken('not-a-jwt')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a validly signed token with no sub claim', () => {
    // A verified signature does not make a usable payload: `typeof decoded.sub !== 'string'` rejects a token with no `sub` as 'invalid'. It is signed with the real secret, so only the missing `sub` is in play.
    const token = jwt.sign({}, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('carries the session id and a unique token id', () => {
    const user = { id: 'user-1' } as User
    const token = signAccessToken(user, 'session-abc')

    const verified = verifyAccessToken(token)
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error('unreachable')
    expect(verified.payload.sub).toBe('user-1')
    expect(verified.payload.sid).toBe('session-abc')
    expect(verified.payload.jti).toEqual(expect.any(String))
  })

  it('gives two tokens for one session different jtis', () => {
    const user = { id: 'user-1' } as User
    const first = verifyAccessToken(signAccessToken(user, 'session-abc'))
    const second = verifyAccessToken(signAccessToken(user, 'session-abc'))
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(first.payload.jti).not.toBe(second.payload.jti)
  })

  it('still verifies a token minted before sid existed, so a deploy does not sign everyone out', () => {
    // `sid` is optional so a token minted without one (by an instance that does not set it, during a rolling deploy) keeps verifying until it expires.
    const legacy = jwt.sign({ sub: 'user-1' }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: 900,
    })
    const verified = verifyAccessToken(legacy)
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error('unreachable')
    expect(verified.payload.sid).toBeUndefined()
  })

  it('carries the verified exp claim, so a caller can schedule work for the moment the token expires', () => {
    const user = { id: 'user-1' } as User
    const before = Math.floor(Date.now() / 1000)
    const verified = verifyAccessToken(signAccessToken(user, 'session-abc'))
    if (!verified.ok) throw new Error('unreachable')
    expect(verified.payload.exp).toEqual(expect.any(Number))
    expect(verified.payload.exp).toBeGreaterThan(before)
  })

  it('signs the session authentication time as auth_time, in whole seconds', () => {
    const user = { id: 'user-1' } as User
    const authenticatedAt = new Date('2026-09-29T10:15:30.999Z')
    const verified = verifyAccessToken(signAccessToken(user, 'session-abc', authenticatedAt))
    if (!verified.ok) throw new Error('unreachable')
    expect(verified.payload.auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000))
  })

  it('omits auth_time when the session has no authentication time', () => {
    const user = { id: 'user-1' } as User
    // eslint-disable-next-line unicorn/no-null -- a session that predates migration 0018 carries null
    const explicitNull = verifyAccessToken(signAccessToken(user, 'session-abc', null))
    const omitted = verifyAccessToken(signAccessToken(user, 'session-abc'))
    if (!explicitNull.ok || !omitted.ok) throw new Error('unreachable')
    expect(explicitNull.payload).not.toHaveProperty('auth_time')
    expect(omitted.payload).not.toHaveProperty('auth_time')
  })

  it('ignores an auth_time that is not a number', () => {
    const token = jwt.sign({ sub: 'user-1', auth_time: 'yesterday' }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: 900,
    })
    const verified = verifyAccessToken(token)
    if (!verified.ok) throw new Error('unreachable')
    expect(verified.payload).not.toHaveProperty('auth_time')
  })
})

describe('hashToken', () => {
  // The FIPS 180-2 test vector for "abc": an independent expected value, not a second call to the same code.
  it('is the hex-encoded SHA-256 digest of the raw token', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
