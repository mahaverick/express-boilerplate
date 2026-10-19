/**
 * @file `requireAuth` against this worker's own database. The file lives
 * under `tests/integration/`, although several cases need no database,
 * because others do: a soft-deleted or deactivated user's still-valid token
 * must be rejected, which needs a real user row. The git hooks run
 * `vitest.unit.config.ts`, which excludes `tests/integration/**` and sets up
 * no database, so a test that touches the database must not move to
 * `tests/unit/` (CLAUDE.md). `pnpm test` runs this file, and every vitest
 * worker owns its database, so files run in parallel.
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
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'

const userRepository = new UserRepository()

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `auth-middleware-${randomUUID()}@example.test`
}

/**
 * A minimal mock request carrying, or omitting, an Authorization header.
 * `requireAuth` reads the request only through `.get('Authorization')` and
 * otherwise assigns properties to it, so nothing else needs to exist.
 */
function buildRequest(header?: string): Request {
  return {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? header : undefined),
  } as unknown as Request
}

/**
 * A `next` spy whose most recent argument reads back as `unknown` instead of
 * `any`, so a test narrows it to `HttpError` without an unsafe assignment.
 */
function mockNext(): { next: NextFunction; lastCallArgument: () => unknown } {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, lastCallArgument: () => spy.mock.calls.at(-1)?.[0] }
}

/**
 * A response with only `set`, which requireAuth calls for its Cache-Control
 * header before anything else; the tests read the outcome off `next`.
 */
const noResponse = { set: vi.fn() } as unknown as Response

describe('requireAuth', () => {
  const createdIds: string[] = []

  afterEach(async () => {
    if (createdIds.length === 0) return
    await sql`delete from users where id = any(${createdIds})`
    createdIds.length = 0
  })

  /**
   * Creates an active user row, tracked for deletion in afterEach.
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
    // A middleware that attached ACCESS_TOKEN_EXPIRED_CODE to every rejection would still pass the other rejection tests; this one pins that a rejected invalid token carries no code.
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
    // toEqual, not toMatchObject: a leaked emailVerifiedAt would slip past a subset match but must fail this one.
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

  // Hand-signed because `signAccessToken` always sets `sid`; this token has none, which the `payload.sid &&` guard in requireAuth must accept.
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
    // Same code as an expired token, deliberately: the client's contract is "try a refresh", which then fails because the session's refresh tokens are revoked in the database before it is denied.
    expect((error as HttpError).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  // A mutation, not a hand edit (CLAUDE.md): `isSessionDenied` resolves true for everything, so only the `payload.sid &&` short-circuit can keep a sid-less token accepted.
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
        // Not toBeInstanceOf(HttpError): vi.resetModules() re-evaluates @/errors/http-error too, so this HttpError is a different class from the one imported here.
        expect(error.statusCode).toBe(401)
        expect(error.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
      }
    )
  })

  // The Redis stand-in's `EXISTS` never settles, as with a connected server that has stopped answering; withMutatedModule also loads a fresh deadline cooldown state, so none leaks into the next test.
  it('lets an authenticated request through, within the deadline, when the denylist read stalls', async () => {
    const user = await createUser()
    const token = signAccessToken(user, randomUUID())

    await withMutatedModule<
      typeof import('@/services/redis.service'),
      typeof import('@/middlewares/auth.middleware')
    >(
      '@/services/redis.service',
      { getRedis: () => Promise.resolve({ exists: stalledCommand } as never) },
      () => import('@/middlewares/auth.middleware'),
      async (subject) => {
        const request = buildRequest(`Bearer ${token}`)
        const { next, lastCallArgument } = mockNext()

        const outcome = await answerWithinBound(subject.requireAuth(request, noResponse, next))

        expect(outcome).not.toBe('hung')
        // The denylist read fails open, so the request is not denied.
        expect(next).toHaveBeenCalledTimes(1)
        expect(lastCallArgument()).toBeUndefined()
        expect(request.user?.id).toBe(user.id)
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
    // code and errors are separate envelope fields (error.middleware.ts); errors stays absent even with code set.
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

describe('requireAuth: Cache-Control', () => {
  it('marks the response no-store before it authenticates, refusal included', async () => {
    const set = vi.fn()
    const { next } = mockNext()

    await requireAuth(buildRequest(), { set } as unknown as Response, next)

    expect(set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
