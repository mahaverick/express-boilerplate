// tests/unit/controllers/profile.controller.test.ts
//
// Covers the defensive 401 branch, the one helpers.controller.ts's
// `authenticatedUserId` guards against, reachable only when a route is wired
// up wrong: every real route these handlers sit behind mounts `requireAuth`
// (auth.middleware.ts) first, and that middleware either populates
// `request.user` or answers 401 itself before this controller ever runs.
// tests/integration/api/profile.test.ts already covers both handlers' "not
// found" 404 branches (a real, later race — the user deleted between
// requireAuth's own lookup and the controller's second one) end to end
// through the real HTTP route; this file is the one way left to reach the
// `!request.user` guard at all, since it requires calling the handler
// directly with no `request.user` set, bypassing routing entirely. No
// database import reached by doing this: `authenticatedUserId` throws
// before either handler ever calls the profile service.
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { profileController } from '@/controllers/profile.controller'
import { HttpError } from '@/errors/http-error'

const unauthenticatedRequest = { user: undefined } as unknown as Request
const unusedResponse = {} as Response

/**
 * Build a `next` spy whose recorded argument is inspectable as `unknown`
 * rather than `any` — same helper and reasoning as
 * tests/integration/middlewares/auth.middleware.test.ts's own `mockNext`.
 * @returns The spy (cast to `NextFunction` for calling a handler) and the argument its most recent call recorded.
 */
function mockNext(): { next: NextFunction; lastCallArgument: () => unknown } {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, lastCallArgument: () => spy.mock.calls.at(-1)?.[0] }
}

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
