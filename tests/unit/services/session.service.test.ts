// tests/unit/services/session.service.test.ts
//
// Pure JWT verify behaviour — no database, no user row. "Issues an access
// token carrying the user id and an expiry" (the property that needs a real
// `User`) lives in tests/integration/services/session.service.test.ts
// instead, against a real created user rather than a hand-built fixture —
// signAccessToken's User parameter has non-optional `T | null` fields
// (mirroring Postgres NULL), and a real row is the natural way to get one
// without constructing null literals by hand.
//
// verifyAccessToken returns a discriminated result rather than throwing
// (VerifyAccessTokenResult, session.service.ts) — every case below asserts
// the FULL literal `{ ok: false, reason }` via toEqual, not just `ok` or
// just `reason` in isolation. That is deliberate: a bare `result.ok` check
// would still pass if a mutation flipped every rejection to the same
// `reason`, and a bare `reason` check would still pass if a mutation somehow
// returned `ok: true` alongside it (impossible today, but the type only
// forbids that by convention, not by a runtime check this test relies on).
// asserting the whole object is what proves both "rejected" and "rejected
// for the right, specific reason" at once.
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import type { User } from '@/database/models/user.model'
import { hashToken, signAccessToken, verifyAccessToken } from '@/services/session.service'

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
      // Already expired the moment it's signed.
      expiresIn: -10,
    })

    // 'expired' specifically, not just "rejected" — this is the entire
    // point of the discriminated result: a caller (auth.middleware.ts)
    // needs to tell "refresh me" apart from "log in again", and only this
    // module has anything trustworthy to say about which one applies.
    expect(verifyAccessToken(token)).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token signed with a different algorithm than HS256 expects', () => {
    // 'none' with an empty signature is the classic alg-confusion probe —
    // pinning `algorithms: ['HS256']` on verify is what stops this. This
    // must resolve 'invalid', not 'expired' — an alg-confusion forgery has
    // no real signature to have expired against; the distinction still
    // needs to name the right bucket, not just "not ok".
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'someone' })).toString('base64url')
    const forged = `${header}.${payload}.`

    expect(verifyAccessToken(forged)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a malformed token string', () => {
    expect(verifyAccessToken('not-a-jwt')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a validly signed token with no sub claim', () => {
    // A verified signature is not by itself a verified PAYLOAD — this is
    // the one branch inside the `ok: true` path that decides the payload
    // itself is unusable (`typeof decoded.sub !== 'string'`) despite the
    // signature checking out. Signed with the REAL secret, so nothing about
    // signature or algorithm is in play here; only the missing `sub` is.
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
    // One release of tolerance. `sid` is optional precisely so tokens issued
    // by the previous version keep working until they expire.
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
})

describe('hashToken', () => {
  // The FIPS 180-2 test vector for "abc": an independent expected value,
  // not a second call to the same code.
  it('is the hex-encoded SHA-256 digest of the raw token', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
