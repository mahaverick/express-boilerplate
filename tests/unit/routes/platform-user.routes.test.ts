/**
 * @file The role gate runs before the limiter on every platform user route:
 * a limiter first would put RateLimit-* headers on the non-staff 404.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createPlatformUserRouter } from '@/routes/platform-user.routes'
import { getPlatformMembership } from '@/services/platform.service'

vi.mock('@/services/platform.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/platform.service')>()),
  getPlatformMembership: vi.fn(),
}))

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  const layers = router.stack as unknown as RouteLayer[]
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

const sharedSearchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
const sharedWriteLimiter = createRateLimiter(RATE_LIMITS.platformWrite)
const limiters = { searchLimiter: sharedSearchLimiter, writeLimiter: sharedWriteLimiter }

describe('createPlatformUserRouter', () => {
  it.each([
    ['get', '/'],
    ['get', '/:id'],
  ])('%s %s: role gate, then the shared search limiter, then the handler', (method, path) => {
    const handlers = handlersFor(createPlatformUserRouter(limiters), method, path)

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })
})

describe('createPlatformUserRouter writes', () => {
  it.each([
    ['post', '/'],
    ['patch', '/:id'],
    ['post', '/:id/password-setup'],
    ['post', '/:id/resend-verification'],
  ])('%s %s: role gate, JSON gate, then the shared write limiter', (method, path) => {
    const handlers = handlersFor(createPlatformUserRouter(limiters), method, path)

    expect(handlers).toHaveLength(4)
    expect(handlers[0]).not.toBe(requireJsonContentType)
    expect(handlers[1]).toBe(requireJsonContentType)
    expect(handlers[2]).toBe(sharedWriteLimiter)
  })
})

describe('createPlatformUserRouter lifecycle routes', () => {
  it.each([
    ['post', '/:id/deactivate', 5],
    ['delete', '/:id', 5],
    ['post', '/:id/purge', 5],
    ['post', '/:id/reactivate', 4],
    ['post', '/:id/sign-out', 4],
  ])('%s %s: the shared write limiter sits just before the handler', (method, path, length) => {
    const handlers = handlersFor(createPlatformUserRouter(limiters), method, path)

    expect(handlers).toHaveLength(length)
    expect(handlers[1]).toBe(requireJsonContentType)
    expect(handlers.at(-2)).toBe(sharedWriteLimiter)
  })
})

/**
 * Run one middleware and return what it passed to `next`.
 * @param handler - The middleware.
 * @param request - The request it sees.
 * @returns The first argument `next` received.
 */
async function nextArgumentOf(
  handler: RequestHandler | undefined,
  request: object
): Promise<unknown> {
  const next = vi.fn()
  await handler?.(request as Request, {} as Response, next as NextFunction)
  expect(next).toHaveBeenCalledOnce()
  return next.mock.calls[0]?.[0]
}

describe('createPlatformUserRouter purge', () => {
  it('post /:id/purge: owner gate, JSON gate, step-up, the shared write limiter, then the handler', async () => {
    const handlers = handlersFor(createPlatformUserRouter(limiters), 'post', '/:id/purge')
    const lookup = vi.mocked(getPlatformMembership)
    const user = { user: { id: 'user-1' } }

    expect(handlers).toHaveLength(5)
    lookup.mockResolvedValueOnce('admin')
    expect(await nextArgumentOf(handlers[0], user)).toMatchObject({ statusCode: 404 })
    lookup.mockResolvedValueOnce('owner')
    expect(await nextArgumentOf(handlers[0], user)).toBeUndefined()
    expect(handlers[1]).toBe(requireJsonContentType)
    expect(await nextArgumentOf(handlers[2], user)).toMatchObject({
      statusCode: 401,
      code: REAUTH_REQUIRED_CODE,
    })
    expect(handlers[3]).toBe(sharedWriteLimiter)
    expect(Object.hasOwn(handlers[4] ?? {}, RATE_LIMITER_MARK)).toBe(false)
  })
})
