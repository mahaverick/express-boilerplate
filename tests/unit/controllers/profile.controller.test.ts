/**
 * @file Covers the defensive 401 branch, the one
 * helpers.controller.ts's `authenticatedUserId` guards against,
 * reachable only when a route is wired up wrong: every real route
 * these handlers sit behind mounts `requireAuth` (auth.middleware.ts)
 * first, which populates `request.user` or answers 401 itself before
 * this controller ever runs.
 */
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { profileController } from '@/controllers/profile.controller'
import { HttpError } from '@/errors/http-error'

const unauthenticatedRequest = { user: undefined } as unknown as Request
const unusedResponse = {} as Response

/**
 * A `next` spy whose recorded argument reads as `unknown` rather than `any`,
 * with a reader for the argument of its most recent call. Mirrors `mockNext`
 * in tests/integration/middlewares/auth.middleware.test.ts.
 */
function mockNext(): { next: NextFunction; lastCallArgument: () => unknown } {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, lastCallArgument: () => spy.mock.calls.at(-1)?.[0] }
}

/**
 * tests/integration/api/profile.test.ts covers both handlers' 404 branches
 * end to end through the real HTTP route: a user deleted between
 * requireAuth's lookup and the handler's second one. Reaching the
 * `!request.user` guard needs a direct call with no `request.user` set,
 * bypassing routing entirely. No query runs: `authenticatedUserId` throws
 * before either handler calls the profile service.
 */
describe('authenticatedUserId (via getProfile/updateProfile)', () => {
  it('getProfile forwards a 401 HttpError to next() when request.user is unset', async () => {
    const { next, lastCallArgument } = mockNext()

    await profileController.getProfile(unauthenticatedRequest, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).message).toBe('Authentication required')
  })

  it('updateProfile forwards the same 401 HttpError to next() when request.user is unset', async () => {
    const { next, lastCallArgument } = mockNext()

    await profileController.updateProfile(unauthenticatedRequest, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
  })
})
