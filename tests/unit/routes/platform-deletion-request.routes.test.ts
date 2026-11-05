/**
 * @file The role gate runs before the limiter on the deletion request list:
 * a limiter first would put RateLimit-* headers on the non-staff 404.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vite-plus/test'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createPlatformDeletionRequestRouter } from '@/routes/platform-deletion-request.routes'

/**
 * A router layer as router@2 builds it. Express's published types describe an
 * older layer shape, so the tests declare the part they read.
 */
interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

/**
 * The handlers of the route with the given method and path, in the order
 * they run; throws when the router has no such route.
 */
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

describe('createPlatformDeletionRequestRouter', () => {
  it('get /: role gate, then the shared search limiter, then the handler', () => {
    const router = createPlatformDeletionRequestRouter({
      searchLimiter: sharedSearchLimiter,
      writeLimiter: sharedWriteLimiter,
    })
    const handlers = handlersFor(router, 'get', '/')

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })

  it('has no other route', () => {
    const router = createPlatformDeletionRequestRouter({
      searchLimiter: sharedSearchLimiter,
      writeLimiter: sharedWriteLimiter,
    })

    expect((router.stack as unknown as RouteLayer[]).filter((layer) => layer.route)).toHaveLength(1)
  })
})
