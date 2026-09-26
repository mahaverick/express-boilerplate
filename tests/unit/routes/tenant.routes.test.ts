// tests/unit/routes/tenant.routes.test.ts
//
// Route wiring that no HTTP test can observe. Redis merges invite and
// resend by their shared `rl:invite-tenant-member:` prefix, but on the
// in-memory fallback each limiter instance counts alone, so the two routes
// must mount the very same instance. Building the router touches no
// database or Redis: every connection is lazy.
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { createTenantRouter } from '@/routes/tenant.routes'

/**
 * The part of an Express 5 router layer this test reads.
 */
interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

/**
 * The handler chain mounted for one method and path.
 * @param router - The router to read.
 * @param method - The lowercase HTTP method.
 * @param path - The route path, exactly as mounted.
 * @returns The handlers, in mount order.
 */
function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  // Express's published types omit `route.methods`, which the runtime layer has.
  const layers = router.stack as unknown as RouteLayer[]
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

describe('createTenantRouter', () => {
  it('mounts one invite limiter instance on both invite and resend', () => {
    const router = createTenantRouter()

    // Position 1: right after requireJsonContentType.
    const [, inviteLimiter] = handlersFor(router, 'post', '/:slug/invitations')
    const [, resendLimiter] = handlersFor(router, 'post', '/:slug/invitations/:id/resend')

    // A rate limiter, not the shared requireJsonContentType or requireAuth.
    expect(inviteLimiter).toHaveProperty('resetKey')
    expect(resendLimiter).toBe(inviteLimiter)
  })

  it('mounts one authenticatedWrite limiter instance across every route that shares it', () => {
    const router = createTenantRouter()
    const writeRoutes: [string, string][] = [
      ['patch', '/:slug'],
      ['patch', '/:slug/members/:userId'],
      ['delete', '/:slug/members/:userId'],
      ['delete', '/:slug/invitations/:id'],
      ['patch', '/:slug/settings'],
    ]

    // Position 1: right after requireJsonContentType, same convention the
    // file's existing invite/resend test already establishes.
    const limiters = writeRoutes.map(([method, path]) => handlersFor(router, method, path)[1])

    for (const limiter of limiters) {
      expect(limiter).toHaveProperty('resetKey')
    }
    const [first, ...rest] = limiters
    for (const limiter of rest) {
      expect(limiter).toBe(first)
    }
  })
})
