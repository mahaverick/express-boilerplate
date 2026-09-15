// tests/unit/middlewares/auth.middleware.test.ts
//
// The header-parsing and token-classification cases (missing/malformed
// header, generic-invalid vs. expired) need no database and are pure unit
// tests. The two cases that actually motivate this middleware's existence
// — a soft-deleted or deactivated user's still-signature-valid token is
// nonetheless rejected — need a real user row, so this file also creates
// and cleans up rows against this worker's own database
// (tests/helpers/worker-database.ts), the same way
// tests/integration/repositories/user.repository.test.ts does. Every
// vitest worker owns its own database, so this is safe to run in parallel
// with every other file.
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE, requireAuth } from '@/middlewares/auth.middleware'
import { HttpError } from '@/middlewares/error.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/utilities/token.utilities'

const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run — avoids colliding with rows
 * any other test in this worker's shared database may be holding onto.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `auth-middleware-${randomUUID()}@example.test`
}

/**
 * Build a minimal mock request carrying (or omitting) an Authorization
 * header. `requireAuth` only ever calls `.get` and assigns `.user`, so
 * nothing else needs to exist on this object — mirroring
 * error.middleware.test.ts's own minimal-mock approach for the same
 * reason.
 * @param header - The Authorization header value, or undefined to omit it.
 * @returns A mock request, mutable enough for `requireAuth` to set `.user` on it.
 */
function buildRequest(header?: string): Request {
  return {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? header : undefined),
  } as unknown as Request
}

/**
 * Build a `next` spy whose recorded argument is inspectable as `unknown`
 * rather than `any` — avoiding an unsafe-assignment escape hatch when a
 * test later narrows it to `HttpError`.
 * @returns The spy (cast to `NextFunction` for calling `requireAuth`) and the argument its most recent call recorded.
 */
function mockNext(): { next: NextFunction; lastCallArgument: () => unknown } {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, lastCallArgument: () => spy.mock.calls.at(-1)?.[0] }
}

const noResponse = {} as Response

describe('requireAuth', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Create a disposable, active user row and track it for cleanup.
   * @returns The created user row.
   */
  async function createUser() {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdIds.push(user.id)
    return user
  }

  it('rejects a request with no Authorization header', async () => {
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest(), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    // Asserted on top of statusCode deliberately: `verifyAccessToken` also
    // rejects an empty/undefined token with its own generic 401, so a
    // mutation that deleted getBearerToken's own guard would still produce
    // *a* 401 by accident, through that fallback. Only the message proves
    // THIS guard — not the downstream one — is what actually fired.
    expect((error as HttpError).message).toMatch(/authorization header/i)
  })

  it.each([
    { label: 'no scheme at all', header: 'just-a-token' },
    { label: 'wrong scheme', header: 'Basic dXNlcjpwYXNz' },
    { label: 'Bearer with no token', header: 'Bearer ' },
    { label: 'Bearer with only whitespace after it', header: 'Bearer    ' },
    { label: 'lowercase scheme', header: 'bearer sometoken' },
  ])('rejects a malformed header: $label', async ({ header }) => {
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest(header), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).message).toMatch(/authorization header/i)
  })

  it('rejects a well-formed but invalid token without the expired-token code', async () => {
    // The negative half of "distinguishable": a token that fails
    // verification for a reason OTHER than expiry must not carry
    // ACCESS_TOKEN_EXPIRED_CODE. Without this, a middleware that attached
    // the code to every rejection would still pass every other test here.
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest('Bearer not-a-real-jwt'), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).errors).toBeUndefined()
  })

  it('populates request.user with the expected shape for a valid token', async () => {
    const user = await createUser()
    const token = signAccessToken(user)
    const request = buildRequest(`Bearer ${token}`)
    const { next, lastCallArgument } = mockNext()

    await requireAuth(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
    // toEqual, not toMatchObject: a leaked passwordHash would slip past a
    // subset match but must fail this one.
    expect(request.user).toEqual({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    })
  })

  it('rejects an expired access token with the distinguishable code', async () => {
    const token = jwt.sign({ sub: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Already expired the moment it's signed — mirrors
      // tests/unit/utilities/token.utilities.test.ts's own approach.
      expiresIn: -10,
    })
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).errors).toEqual({ code: ACCESS_TOKEN_EXPIRED_CODE })
  })

  it('rejects a valid, unexpired token for a soft-deleted user', async () => {
    const user = await createUser()
    const token = signAccessToken(user)
    await userRepository.softDelete(user.id)

    const { next, lastCallArgument } = mockNext()
    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
  })

  it('rejects a valid, unexpired token for a deactivated (active: false) user', async () => {
    const user = await createUser()
    const token = signAccessToken(user)
    await userRepository.update(user.id, { active: false })

    const { next, lastCallArgument } = mockNext()
    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
  })
})
