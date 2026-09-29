/**
 * @file The role gate runs before the limiter on every platform user route:
 * a limiter first would put RateLimit-* headers on the non-staff 404.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createPlatformUserRouter } from '@/routes/platform-user.routes'

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
    ['post', '/:id/reactivate', 4],
    ['post', '/:id/sign-out', 4],
  ])('%s %s: the shared write limiter sits just before the handler', (method, path, length) => {
    const handlers = handlersFor(createPlatformUserRouter(limiters), method, path)

    expect(handlers).toHaveLength(length)
    expect(handlers[1]).toBe(requireJsonContentType)
    expect(handlers.at(-2)).toBe(sharedWriteLimiter)
  })
})
