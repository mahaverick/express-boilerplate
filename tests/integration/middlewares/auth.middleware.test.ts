/**
 * @file Lives under `tests/integration/`, not `tests/unit/`, even though
 * several cases here need no database at all: the two that actually
 * motivate this middleware's existence — a soft-deleted or deactivated
 * user's still-signature-valid token is nonetheless rejected — need a real
 * user row against this worker's own database. `vitest.unit.config.ts`
 * (the git hooks' config) excludes `tests/integration/**` and sets up no
 * database, so a database-touching test must not move there; see
 * CLAUDE.md for why. `pnpm test` still runs this file, and every vitest
 * worker owns its own database, so it is safe to run in parallel with
 * every other file.
 */
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { ACCESS_TOKEN_EXPIRED_CODE } from '@/constants/auth.constants'
import { HttpError } from '@/errors/http-error'
import { requireAuth } from '@/middlewares/auth.middleware'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { requestContextStore } from '@/services/request-context.service'
import { denySession } from '@/services/session-denylist.service'
import { signAccessToken } from '@/services/session.service'
import { withMutatedModule } from '../../helpers/mutate'

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
    // On top of statusCode deliberately: verifyAccessToken also rejects an empty token with its own generic 401, so only the message proves THIS guard fired, not that fallback.
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
    // The negative half of "distinguishable": a middleware that attached ACCESS_TOKEN_EXPIRED_CODE to every rejection would still pass every other test here.
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest('Bearer not-a-real-jwt'), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    // `code`, not `errors`, is where ACCESS_TOKEN_EXPIRED_CODE actually lives (HttpError's 3rd constructor argument).
    expect((error as HttpError).code).toBeUndefined()
    expect((error as HttpError).errors).toBeUndefined()
  })

  it('populates request.user with the expected shape for a valid token', async () => {
    const user = await createUser()
    const token = signAccessToken(user, randomUUID())
    const request = buildRequest(`Bearer ${token}`)
    const { next, lastCallArgument } = mockNext()

    await requireAuth(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
    // toEqual, not toMatchObject: a leaked passwordHash would slip past a subset match but must fail this one.
    expect(request.user).toEqual({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    })
  })

  it('puts the authenticated user id in the request context, and none when auth fails', async () => {
    const user = await createUser()
    const token = signAccessToken(user, randomUUID())
    const context = { requestId: randomUUID() }
    await requestContextStore.run(context, () =>
      requireAuth(buildRequest(`Bearer ${token}`), noResponse, mockNext().next)
    )
    expect(context).toMatchObject({ userId: user.id })

    const rejected = { requestId: randomUUID() }
    await requestContextStore.run(rejected, () =>
      requireAuth(buildRequest('Bearer not-a-real-jwt'), noResponse, mockNext().next)
    )
    expect(rejected).not.toHaveProperty('userId')
  })

  /**
   * Hand-signed, deliberately not via `signAccessToken`, which always sets
   * `sid`: this reproduces a token minted before that claim existed. Do not
   * "modernise" this to `signAccessToken` — that would delete the one case
   * pinning `auth.middleware.ts`'s `payload.sid && ...` guard as tested.
   */
  it('accepts a token with no `sid` claim — one release of tolerance for tokens minted before this claim existed', async () => {
    const user = await createUser()
    const token = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    })
    const request = buildRequest(`Bearer ${token}`)
    const { next, lastCallArgument } = mockNext()

    await requireAuth(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
    expect(request.user).toEqual({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    })
  })

  it('rejects a token whose session has been denied', async () => {
    const user = await createUser()
    const sessionId = randomUUID()
    const token = signAccessToken(user, sessionId)
    await denySession(sessionId)

    const { next, lastCallArgument } = mockNext()
    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    // Same code as an expired token, deliberately: the client-facing contract is "try a refresh", and the refresh token was revoked in the same operation that denied this session.
    expect((error as HttpError).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  /**
   * Mutation, not a hand edit (see CLAUDE.md): `isSessionDenied` is
   * overridden to resolve `true` unconditionally, so only the
   * `payload.sid &&` short-circuit can keep a sid-less token accepted
   * below.
   */
  it('keeps a sid-less token honoured even when the denylist would deny every session, proving `payload.sid &&` is a real short-circuit', async () => {
    const user = await createUser()

    await withMutatedModule<
      typeof import('@/services/session-denylist.service'),
      typeof import('@/middlewares/auth.middleware')
    >(
      '@/services/session-denylist.service',
      { isSessionDenied: () => Promise.resolve(true) },
      () => import('@/middlewares/auth.middleware'),
      async (subject) => {
        const sidLessToken = jwt.sign({ sub: user.id }, getEnv().JWT_ACCESS_SECRET, {
          algorithm: 'HS256',
          expiresIn: '15m',
        })
        const accepted = mockNext()
        await subject.requireAuth(buildRequest(`Bearer ${sidLessToken}`), noResponse, accepted.next)
        expect(accepted.next).toHaveBeenCalledTimes(1)
        expect(accepted.lastCallArgument()).toBeUndefined()

        // Same mutated environment, but this token HAS a sid: it must be denied, proving isSessionDenied is genuinely wired in, not dead code.
        const sidToken = signAccessToken(user, randomUUID())
        const denied = mockNext()
        await subject.requireAuth(buildRequest(`Bearer ${sidToken}`), noResponse, denied.next)
        const error = denied.lastCallArgument() as { statusCode?: number; code?: string }
        // Not toBeInstanceOf(HttpError): vi.resetModules() re-evaluates error.middleware.ts too, giving a different HttpError class identity — a false negative, not a real failure.
        expect(error.statusCode).toBe(401)
        expect(error.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
      }
    )
  })

  it('rejects an expired access token with the distinguishable code', async () => {
    const token = jwt.sign({ sub: randomUUID() }, getEnv().JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      // Already expired the moment it's signed.
      expiresIn: -10,
    })
    const { next, lastCallArgument } = mockNext()

    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    // code and errors are separate envelope fields (error.middleware.ts); asserting errors is still absent proves they stay independent even with code set.
    expect((error as HttpError).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
    expect((error as HttpError).errors).toBeUndefined()
  })

  it('rejects a valid, unexpired token for a soft-deleted user', async () => {
    const user = await createUser()
    const token = signAccessToken(user, randomUUID())
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
    const token = signAccessToken(user, randomUUID())
    await userRepository.update(user.id, { active: false })

    const { next, lastCallArgument } = mockNext()
    await requireAuth(buildRequest(`Bearer ${token}`), noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
  })
})
