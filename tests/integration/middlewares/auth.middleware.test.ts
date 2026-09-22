// tests/integration/middlewares/auth.middleware.test.ts
//
// Lives under tests/integration/, not tests/unit/, even though several
// cases here (missing/malformed header, generic-invalid vs. expired) need
// no database at all — because the two cases that actually motivate this
// middleware's existence (a soft-deleted or deactivated user's
// still-signature-valid token is nonetheless rejected) need a real user
// row, and this file creates and cleans up rows against this worker's own
// database (tests/helpers/worker-database.ts) to get one, the same way
// tests/integration/repositories/user.repository.test.ts does. A
// database-touching test under tests/unit/ would run inside
// `.husky/pre-commit`'s `vitest run --changed HEAD --exclude
// 'tests/integration/**'`, which is exactly the failure mode CLAUDE.md
// documents pre-commit as designed to avoid: a hook that fails whenever
// Docker happens to be down gets `--no-verify`'d permanently and never
// comes back. `pnpm test` (no --exclude) still runs this file; every
// vitest worker owns its own database, so it is safe to run in parallel
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
import { denySession } from '@/services/session-denylist.service'
import { signAccessToken } from '@/utilities/token.utilities'
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
    // `code` — not `errors` — is where ACCESS_TOKEN_EXPIRED_CODE actually
    // lives (HttpError's 3rd constructor argument); asserting its absence
    // here is the negative half of "distinguishable" for the real field.
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
    // toEqual, not toMatchObject: a leaked passwordHash would slip past a
    // subset match but must fail this one.
    expect(request.user).toEqual({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    })
  })

  it('accepts a token with no `sid` claim — one release of tolerance for tokens minted before this claim existed', async () => {
    // Hand-signed, deliberately NOT via signAccessToken: Task 1 made
    // signAccessToken always set `sid`, so it can no longer produce the
    // shape this test needs — a token minted by the currently-deployed
    // version, before the `sid` claim existed. Do not "modernise" this call
    // to `signAccessToken`; that would silently delete the one case this
    // test exists to pin down, and the guard it protects
    // (`payload.sid && ...` in auth.middleware.ts) would go back to being
    // an untested, deletable half of a compound condition.
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
    // Same code as an expired token, deliberately (see
    // auth.middleware.ts): the client-facing contract is "try a refresh",
    // and the refresh token was revoked in the same operation that denied
    // this session.
    expect((error as HttpError).code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
  })

  it('keeps a sid-less token honoured even when the denylist would deny every session, proving `payload.sid &&` is a real short-circuit', async () => {
    // WHY THIS IS A MUTATION TEST, NOT A HAND EDIT. CLAUDE.md ("Proving a
    // security behaviour is real, without hand-editing src/") forbids
    // temporarily breaking auth.middleware.ts on disk to see what happens
    // if `payload.sid &&` were removed — that puts a live "sign everyone
    // out on deploy" regression on disk in a shared worktree, even for a
    // moment. withMutatedModule gets the same evidence without it:
    // isSessionDenied is overridden to resolve `true` UNCONDITIONALLY,
    // regardless of the argument it's called with (including `undefined`).
    //
    // Under that mutation: a token WITH a sid is denied (the wiring works),
    // while a token WITHOUT one is still accepted — which is only possible
    // because the guard short-circuits on `payload.sid` before ever calling
    // isSessionDenied. If `payload.sid &&` were deleted, the sid-less
    // token's call would become `isSessionDenied(undefined)` — and this
    // mock returns `true` no matter what it's called with — so that
    // regression would flip the first assertion below to a 401 and turn
    // this test red — deterministically, since the mock's return value
    // does not depend on its argument at all.
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

        // Same mutated environment, but this token HAS a sid: it must be
        // denied, proving isSessionDenied is genuinely wired into the
        // guard and not merely unreachable dead code.
        const sidToken = signAccessToken(user, randomUUID())
        const denied = mockNext()
        await subject.requireAuth(buildRequest(`Bearer ${sidToken}`), noResponse, denied.next)
        const error = denied.lastCallArgument() as { statusCode?: number; code?: string }
        // Not `toBeInstanceOf(HttpError)`: withMutatedModule's
        // vi.resetModules() re-evaluates error.middleware.ts too, so the
        // thrown error is an instance of a DIFFERENT HttpError class
        // object than the one imported at this file's top — a false
        // negative, not a real failure. statusCode/code are plain
        // properties and unaffected by that class-identity split.
        expect(error.statusCode).toBe(401)
        expect(error.code).toBe(ACCESS_TOKEN_EXPIRED_CODE)
      }
    )
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
    // The distinguishable code is a real `code` field (HttpError's 3rd
    // constructor argument, threaded through to the JSON envelope's own
    // `code` key by error.middleware.ts) — not smuggled through `errors`,
    // which is documented as validator field-detail. Asserting `errors` is
    // still absent here proves the two fields stay independent even when
    // one of them (`code`) is set.
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
