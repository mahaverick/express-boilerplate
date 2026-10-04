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
  handle: { stack?: RouteLayer[] }
  path?: string
  match(path: string): boolean
}

function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  return handlersIn(router.stack as unknown as RouteLayer[], method, path)
}

function handlersIn(layers: RouteLayer[], method: string, path: string): RequestHandler[] {
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

  it('gates the tenant timeline at admin, then the timeline limiter', () => {
    const handlers = handlersFor(createPlatformRouter(), 'get', '/tenants/:id/timeline')

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect((handlers[1] as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe(
      'platform-timeline'
    )
  })

  it('shares one timeline limiter between the user and the tenant timelines', () => {
    const router = createPlatformRouter()
    const users = (router.stack as unknown as RouteLayer[]).find(
      (layer) =>
        Array.isArray(layer.handle.stack) && layer.match('/users') && layer.path === '/users'
    )
    if (!users?.handle.stack) throw new Error('no /users sub-router')

    const userLimiter = handlersIn(users.handle.stack, 'get', '/:id/timeline')[1]
    const tenantLimiter = handlersFor(router, 'get', '/tenants/:id/timeline')[1]

    expect(userLimiter).toBe(tenantLimiter)
  })
})
