// tests/unit/controllers/notification.controller.test.ts
//
// Covers `authenticatedUserId`'s own defensive 401 branch, and the three
// handlers whose `catch` block nothing else in this suite exercises —
// `listNotifications`, `markAllRead`, `getPreferences`. Same reasoning as
// tests/unit/controllers/profile.controller.test.ts: notification.routes.ts
// mounts `requireAuth` router-wide, so `request.user` is always populated by
// the time any of these run through a real route; reaching the guard at all
// needs a direct call with no `request.user` set, bypassing routing
// entirely. `markRead`/`deleteNotification`/`updatePreferences` each already
// have their own catch block covered by a real error scenario in
// tests/integration/api/notification.test.ts (a 404 for a nonexistent
// notification, an invalid preferences body), so they are not repeated here.
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import {
  getPreferences,
  listNotifications,
  markAllRead,
} from '@/controllers/notification.controller'
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

/**
 * Assert that calling `handler` with no `request.user` forwards a 401
 * `HttpError` to `next()`.
 * @param handler - The controller handler under test.
 */
async function expectAuthenticationRequired(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
): Promise<void> {
  const { next, lastCallArgument } = mockNext()

  await handler(unauthenticatedRequest, unusedResponse, next)

  expect(next).toHaveBeenCalledTimes(1)
  const error = lastCallArgument()
  expect(error).toBeInstanceOf(HttpError)
  expect((error as HttpError).statusCode).toBe(401)
  expect((error as HttpError).message).toBe('Authentication required')
}

describe('authenticatedUserId (via each handler that reaches it first)', () => {
  it('listNotifications forwards a 401 HttpError to next() when request.user is unset', async () => {
    await expectAuthenticationRequired(listNotifications)
  })

  it('markAllRead forwards a 401 HttpError to next() when request.user is unset', async () => {
    await expectAuthenticationRequired(markAllRead)
  })

  it('getPreferences forwards a 401 HttpError to next() when request.user is unset', async () => {
    await expectAuthenticationRequired(getPreferences)
  })
})
