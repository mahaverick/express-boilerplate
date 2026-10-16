/**
 * @file The role gate must run before the limiter: a limiter first would
 * put RateLimit-* headers on the non-staff 404 and reveal the route.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createPlatformRouter } from '@/routes/platform.routes'
import { getPlatformMembership } from '@/services/platform.service'

vi.mock('@/services/platform.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/platform.service')>()),
  getPlatformMembership: vi.fn(),
}))

const lookup = vi.mocked(getPlatformMembership)

/**
 * Runs a route's first handler for a caller whose platform role is `role`.
 * @param gate - The handler.
 * @param role - The caller's platform role, or null for a non-staff user.
 * @returns The arguments of each `next` call.
 */
async function runGate(
  gate: RequestHandler | undefined,
  role: 'viewer' | null
): Promise<unknown[][]> {
  lookup.mockResolvedValueOnce(role)
  const next = vi.fn()
  await gate?.(
    { user: { id: 'user-1' } } as unknown as Request,
    { locals: {} } as unknown as Response,
    next as NextFunction
  )
  return next.mock.calls
}

/**
 * A router layer as these tests read it: a route's path, methods and handler
 * stack, or a mounted sub-router with its own stack, path and matcher.
 */
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

/**
 * The handlers of the route with the given method and path directly on the
 * router, in the order they run; throws when there is none.
 */
function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  return handlersIn(router.stack as unknown as RouteLayer[], method, path)
}

/**
 * The handlers of the route with the given method and path among the given
 * layers, in the order they run; throws when there is none.
 */
function handlersIn(layers: RouteLayer[], method: string, path: string): RequestHandler[] {
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

describe('createPlatformRouter', () => {
  afterEach(() => {
    lookup.mockReset()
  })

  it('checks the platform role before the search limiter', () => {
    const [roleGate, limiter, handler] = handlersFor(createPlatformRouter(), 'get', '/tenants')

    expect(roleGate).not.toHaveProperty('resetKey')
    expect(limiter).toHaveProperty('resetKey')
    expect(handler).toBeDefined()
  })

  it('gates the platform audit log at admin, then the shared search limiter', () => {
    const router = createPlatformRouter()
    const handlers = handlersFor(router, 'get', '/audit-log')

    expect(handlers).toHaveLength(3)
    expect(handlers[0]).not.toHaveProperty('resetKey')
    expect((handlers[1] as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]).toBe(
      'platform-search'
    )
    expect(handlers[1]).toBe(handlersFor(router, 'get', '/tenants')[1])
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

  it.each(['/flags', '/flags/unregistered', '/flags/meta'])(
    'gates GET %s at the platform role, then the shared search limiter',
    async (path) => {
      const router = createPlatformRouter()
      const handlers = handlersFor(router, 'get', path)

      expect(handlers).toHaveLength(3)
      expect(await runGate(handlers[0], 'viewer')).toEqual([[]])
      // eslint-disable-next-line unicorn/no-null -- getPlatformMembership answers null for non-staff
      const [refusal] = await runGate(handlers[0], null)
      expect(refusal?.[0]).toMatchObject({ message: 'Not found', statusCode: 404 })
      expect(handlers[1]).toBe(handlersFor(router, 'get', '/tenants')[1])
    }
  )

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
