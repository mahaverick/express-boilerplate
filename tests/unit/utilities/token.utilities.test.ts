// tests/unit/utilities/token.utilities.test.ts
//
// Pure JWT verify behaviour — no database, no user row. "Issues an access
// token carrying the user id and an expiry" (the property that needs a real
// `User`) lives in tests/integration/utilities/token.utilities.test.ts
// instead, against a real created user rather than a hand-built fixture —
// signAccessToken's User parameter has non-optional `T | null` fields
// (mirroring Postgres NULL), and a real row is the natural way to get one
// without constructing null literals by hand.
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { HttpError } from '@/middlewares/error.middleware'
import { verifyAccessToken } from '@/utilities/token.utilities'

describe('verifyAccessToken', () => {
  it('rejects a token signed with the wrong secret', () => {
    const wrongKey = 'a-completely-different-signing-value-32-chars'
    const token = jwt.sign({ sub: 'someone' }, wrongKey, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })

    expect(() => verifyAccessToken(token)).toThrow(HttpError)
    try {
      verifyAccessToken(token)
      expect.unreachable('verifyAccessToken should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).statusCode).toBe(401)
    }
  })

  it('rejects an expired access token', () => {
    const token = jwt.sign({ sub: 'someone' }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Already expired the moment it's signed.
      expiresIn: -10,
    })

    expect(() => verifyAccessToken(token)).toThrow(HttpError)
  })

  it('rejects a token signed with a different algorithm than HS256 expects', () => {
    // 'none' with an empty signature is the classic alg-confusion probe —
    // pinning `algorithms: ['HS256']` on verify is what stops this.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'someone' })).toString('base64url')
    const forged = `${header}.${payload}.`

    expect(() => verifyAccessToken(forged)).toThrow(HttpError)
  })

  it('rejects a malformed token string', () => {
    expect(() => verifyAccessToken('not-a-jwt')).toThrow(HttpError)
  })
})
