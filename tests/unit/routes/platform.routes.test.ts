/**
 * @file The role gate must run before the limiter: a limiter first would
 * put RateLimit-* headers on the non-staff 404 and reveal the route.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createPlatformRouter } from '@/routes/platform.routes'

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

describe('createPlatformRouter', () => {
  it('checks the platform role before the search limiter', () => {
    const [roleGate, limiter, handler] = handlersFor(createPlatformRouter(), 'get', '/tenants')

    expect(roleGate).not.toHaveProperty('resetKey')
    expect(limiter).toHaveProperty('resetKey')
    expect(handler).toBeDefined()
  })

  it('gates the platform audit log at admin, with no limiter', () => {
    const handlers = handlersFor(createPlatformRouter(), 'get', '/audit-log')

    expect(handlers).toHaveLength(2)
    expect(handlers[0]).not.toHaveProperty('resetKey')
  })

  it('shares one search limiter across the viewer GETs, so they draw on one budget', () => {
    const router = createPlatformRouter()
    const tenantsLimiter = handlersFor(router, 'get', '/tenants')[1]
    const statsLimiter = handlersFor(router, 'get', '/stats')[1]

    expect(Object.hasOwn(tenantsLimiter as object, RATE_LIMITER_MARK)).toBe(true)
    expect((tenantsLimiter as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe(
      'platform-search'
    )
    expect(statsLimiter).toBe(tenantsLimiter)
  })

  it('gates the tenant purge: role, JSON, step-up, then the shared write limiter', () => {
    const handlers = handlersFor(createPlatformRouter(), 'post', '/tenants/:id/purge')

    expect(handlers).toHaveLength(5)
    expect(handlers[1]).toBe(requireJsonContentType)
    expect((handlers[3] as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe(
      'platform-write'
    )
  })
})
