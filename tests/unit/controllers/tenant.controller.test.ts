// tests/unit/controllers/tenant.controller.test.ts
//
// Covers the branches tests/integration/api/tenant.test.ts cannot reach
// through the HTTP layer — every one of them a defensive check the file's
// own header comment (and each function's own comment) describes as
// unreachable through a correctly-wired route, plus the one pure function
// (`canActorGrantRole`) whose full domain router-level `requireRole` never
// lets a real request exercise:
//
//   - `authenticatedUserId`'s 401 (mirrors profile.controller.test.ts's own
//     version): `tenant.routes.ts` mounts `requireAuth` router-wide, so
//     `request.user` is always set by the time any handler here runs.
//   - `tenantPrincipal`'s 404: every `/tenants/:slug/...` route mounts
//     `resolveTenant` ahead of its handler, so `request.principal` is
//     always set too.
//   - `targetUserIdParameter`'s 400: a plain `:userId` path segment can
//     never actually parse as `string[] | undefined` — Express's own
//     `ParamsDictionary` typing allows it only for a route pattern this
//     codebase does not use. Reaching it needs a param object Express
//     itself would never build.
//   - `canActorGrantRole`'s final `return false`: router-level
//     `requireRole('owner', 'admin')` (tenant.routes.ts) never lets a
//     manager/editor/viewer actor reach `inviteMember` at all, so no real
//     request can ever supply the `actorRole` this branch handles.
//
// Every case below calls the exported handler/function directly, the same
// technique tests/unit/controllers/profile.controller.test.ts already
// establishes, rather than routing through `createApp()` — no database
// import is reached by doing this: every branch here throws (or returns)
// before any repository call.
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import {
  canActorGrantRole,
  listMembers,
  listTenants,
  updateMemberRole,
} from '@/controllers/tenant.controller'
import { HttpError } from '@/errors/http-error'
import type { RequestPrincipal } from '@/middlewares/tenant.middleware'

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

const authenticatedPrincipal: RequestPrincipal = {
  tenantId: 'tenant-id',
  tenantSlug: 'acme',
  role: 'owner',
}

describe('canActorGrantRole', () => {
  it.each(['manager', 'editor', 'viewer'] as const)(
    'refuses a %s actor — router-level requireRole never lets one reach inviteMember, but this must fail closed anyway',
    (actorRole) => {
      expect(canActorGrantRole(actorRole, 'viewer')).toBe(false)
    }
  )
})

describe('authenticatedUserId (via listTenants)', () => {
  it('forwards a 401 HttpError to next() when request.user is unset', async () => {
    const { next, lastCallArgument } = mockNext()
    const request = { user: undefined } as unknown as Request

    await listTenants(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).message).toBe('Authentication required')
  })
})

describe('tenantPrincipal (via listMembers)', () => {
  it('forwards a 404 HttpError to next() when request.principal is unset', async () => {
    const { next, lastCallArgument } = mockNext()
    const request = { principal: undefined } as unknown as Request

    await listMembers(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect((error as HttpError).message).toBe('Tenant not found')
  })
})

describe('targetUserIdParameter (via updateMemberRole)', () => {
  it('forwards a 400 HttpError to next() when :userId is not a single string — a routing bug, not a real request shape', async () => {
    const { next, lastCallArgument } = mockNext()
    const request = {
      user: {
        id: 'actor-id',
        email: 'actor@example.test',
        firstName: undefined,
        lastName: undefined,
      },
      principal: authenticatedPrincipal,
      params: { userId: ['not', 'a', 'single', 'string'] },
      body: {},
    } as unknown as Request

    await updateMemberRole(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(400)
    expect((error as HttpError).message).toBe('Malformed member id')
  })
})
