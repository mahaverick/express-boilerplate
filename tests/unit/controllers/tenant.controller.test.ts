/**
 * @file Covers the branches tests/integration/api/tenant.test.ts
 * cannot reach through the HTTP layer, every one a defensive check
 * unreachable through a correctly-wired route. Every case below calls
 * a `tenantController` handler directly rather than routing through
 * `createApp()` — no database import is reached by doing this, since
 * every branch here throws or returns before any service call.
 */
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { tenantController } from '@/controllers/tenant.controller'
import { HttpError } from '@/errors/http-error'
import type { RequestPrincipal } from '@/types/actor'

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
  isPlatformTenant: false,
  role: 'owner',
  memberRole: 'owner',
  // eslint-disable-next-line unicorn/no-null -- a member's principal carries no platform role
  platformRole: null,
  access: 'member',
}

// `tenant.routes.ts` mounts `requireAuth` router-wide, so `request.user` is always set by the time any handler here runs — reaching this 401 needs a direct call, bypassing routing entirely.
describe('authenticatedUserId (via listTenants)', () => {
  it('forwards a 401 HttpError to next() when request.user is unset', async () => {
    const { next, lastCallArgument } = mockNext()
    const request = { user: undefined } as unknown as Request

    await tenantController.listTenants(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).message).toBe('Authentication required')
  })
})

// Every `/tenants/:slug/...` route mounts `resolveTenant` ahead of its handler, so `request.principal` is always set too — reaching this 404 needs a direct call, bypassing routing entirely.
describe('tenantPrincipal (via listMembers)', () => {
  it('forwards a 404 HttpError to next() when request.principal is unset', async () => {
    const { next, lastCallArgument } = mockNext()
    const request = { principal: undefined } as unknown as Request

    await tenantController.listMembers(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect((error as HttpError).message).toBe('Tenant not found')
  })
})

// A plain `:userId` path segment can never actually parse as `string[] | undefined` under this codebase's route patterns; this param object is one Express itself would never build, and it gets the same 404 as any id that is not a UUID.
describe('targetUserIdParameter (via updateMemberRole)', () => {
  it('forwards a 404 HttpError to next() when :userId is not a single string, as for any id that is not a UUID', async () => {
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

    await tenantController.updateMemberRole(request, unusedResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect((error as HttpError).message).toBe('Member not found')
    expect((error as HttpError).code).toBe('member_not_found')
  })
})
