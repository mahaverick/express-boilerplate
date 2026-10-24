/**
 * @file Walks the live app's router stack (built the same way
 * createApp() itself builds it, so no route list is hardcoded here) and
 * asserts every POST/PUT/PATCH/DELETE route either carries a rate
 * limiter (RATE_LIMITER_MARK on one of its handlers) or is named on
 * ALLOWLIST with a reason. Express 5 has no `app._router`; `app.router`
 * is a lazy getter (application.js) over the standalone `router`
 * package. Express's type declarations describe its layers as `ILayer`
 * (a `regexp`, a `handle` with no `.stack`), which does not match
 * router@2's layers, hence the local shapes and the one cast.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { withMutatedModule } from '../../helpers/mutate'

const WRITE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete'])

/**
 * One handler on a route, with the HTTP method it was registered for.
 */
interface RouteHandlerLayer {
  method?: string
  handle: RequestHandler
}

/**
 * A route as router@2 builds it: its path and the handlers registered on it.
 */
interface BuiltRoute {
  path: string
  stack: RouteHandlerLayer[]
}

/**
 * A router layer: a route, or a mounted router whose handle carries its own
 * stack.
 */
interface RouterStackLayer {
  route?: BuiltRoute
  handle: RequestHandler & { stack?: RouterStackLayer[] }
}

/**
 * One route the walk found for one method, with its handlers in order.
 */
interface DiscoveredRoute {
  method: string
  path: string
  handlers: RequestHandler[]
}

/**
 * Every route reachable from `stack` whose method is in `methods`,
 * recursing into mounted sub-routers. A sub-router is any layer whose
 * `.handle` itself carries a `.stack` array — the shape `Router()` always
 * returns (router@2.2.0's own factory), regardless of which feature router
 * built it. `methods` holds the lowercase HTTP methods to collect.
 */
function collectRoutes(
  stack: RouterStackLayer[],
  methods: ReadonlySet<string>,
  into: DiscoveredRoute[]
): void {
  for (const layer of stack) {
    if (layer.route) {
      const byMethod = new Map<string, RequestHandler[]>()
      for (const routeLayer of layer.route.stack) {
        if (!routeLayer.method || !methods.has(routeLayer.method)) continue
        const handlers = byMethod.get(routeLayer.method) ?? []
        handlers.push(routeLayer.handle)
        byMethod.set(routeLayer.method, handlers)
      }
      for (const [method, handlers] of byMethod) {
        into.push({ method, path: layer.route.path, handlers })
      }
    } else if (Array.isArray(layer.handle.stack)) {
      collectRoutes(layer.handle.stack, methods, into)
    }
  }
}

/**
 * The live app's routes whose lowercase method is in `methods`, walked from
 * `app.router`; the one local cast reads its layers as `RouterStackLayer`.
 */
function routesOf(
  app: ReturnType<typeof createApp>,
  methods: ReadonlySet<string>
): DiscoveredRoute[] {
  const withRouter = app as unknown as { router: { stack: RouterStackLayer[] } }
  const routes: DiscoveredRoute[] = []
  collectRoutes(withRouter.router.stack, methods, routes)
  return routes
}

/**
 * The live app's POST/PUT/PATCH/DELETE routes.
 */
function writeRoutesOf(app: ReturnType<typeof createApp>): DiscoveredRoute[] {
  return routesOf(app, WRITE_METHODS)
}

/**
 * Whether any of a route's handlers carries `RATE_LIMITER_MARK`.
 */
function hasRateLimiter(handlers: RequestHandler[]): boolean {
  return handlers.some((handler) => Object.hasOwn(handler, RATE_LIMITER_MARK))
}

/**
 * The limiter names a route's handlers carry, in order.
 */
function limiterMarksOf(route: DiscoveredRoute | undefined): unknown[] {
  return (route?.handlers ?? [])
    .map((handler) => (handler as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK])
    .filter((mark) => mark !== undefined)
}

/**
 * Routes deliberately exempt from carrying any rate limiter, with why.
 * Empty: every write route either has its own route-specific limiter or
 * gets `authenticatedWrite`. Kept as a mechanism for a legitimate exception
 * rather than removed.
 */
const ALLOWLIST: { method: string; path: string; reason: string }[] = []

/**
 * Whether the route is named on `ALLOWLIST`, and so exempt from needing a
 * rate limiter.
 */
function isAllowlisted(route: DiscoveredRoute): boolean {
  return ALLOWLIST.some((entry) => entry.method === route.method && entry.path === route.path)
}

describe('every write route carries a rate limiter', () => {
  it('has one on every POST/PUT/PATCH/DELETE route, or is on ALLOWLIST', () => {
    const routes = writeRoutesOf(createApp())
    expect(routes.length).toBeGreaterThan(0)

    const unlimited = routes.filter(
      (route) => !isAllowlisted(route) && !hasRateLimiter(route.handlers)
    )

    expect(unlimited).toEqual([])
  })

  it('walks the email webhook route, mounted on the app outside createApiRouter, and limits it per provider', () => {
    const webhook = writeRoutesOf(createApp()).find(
      (route) => route.method === 'post' && route.path === '/:provider'
    )

    expect(webhook).toBeDefined()
    const marks = (webhook?.handlers ?? []).map(
      (handler) => (handler as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK]
    )
    expect(marks).toContain(RATE_LIMITS.emailWebhook.name)
    expect(marks).toContain(RATE_LIMITS.emailWebhookRejected.name)
  })

  it('gives every billing write one shared billing-write limiter and the invoice list billing-read', () => {
    const app = createApp()
    const writes = writeRoutesOf(app).filter((route) => route.path.startsWith('/:slug/billing'))
    expect(writes.map((route) => route.path).toSorted()).toEqual([
      '/:slug/billing/cancel',
      '/:slug/billing/checkout',
      '/:slug/billing/checkout/confirm',
      '/:slug/billing/interval',
      '/:slug/billing/payment-method',
    ])
    for (const route of writes)
      expect(limiterMarksOf(route)).toEqual([RATE_LIMITS.billingWrite.name])
    const limiters = new Set(
      writes.map((route) =>
        route.handlers.find((handler) => Object.hasOwn(handler, RATE_LIMITER_MARK))
      )
    )
    // One instance across the five writes, so the in-memory fallback keeps one budget.
    expect(limiters.size).toBe(1)
    const invoices = routesOf(app, new Set(['get'])).find(
      (route) => route.path === '/:slug/billing/invoices'
    )
    expect(limiterMarksOf(invoices)).toEqual([RATE_LIMITS.billingRead.name])
  })

  it('fails when a route loses its limiter — proven by removing authenticatedWrite’s marker', async () => {
    const { createRateLimiter: realCreateRateLimiter } =
      await import('@/middlewares/rate-limit.middleware')

    await withMutatedModule(
      '@/middlewares/rate-limit.middleware',
      {
        createRateLimiter: ((spec, overrides) => {
          if (spec.name === RATE_LIMITS.authenticatedWrite.name) {
            return (_request: Request, _response: Response, next: NextFunction) => {
              next()
            }
          }
          return realCreateRateLimiter(spec, overrides)
        }) as typeof createRateLimiter,
      },
      () => import('@/app'),
      ({ createApp: mutatedCreateApp }) => {
        const routes = writeRoutesOf(mutatedCreateApp())
        const unlimited = routes.filter(
          (route) => !isAllowlisted(route) && !hasRateLimiter(route.handlers)
        )
        expect(unlimited.length).toBeGreaterThan(0)
      }
    )
  })

  it('never mounts authenticatedWrite on a GET route', () => {
    const reads = routesOf(createApp(), new Set(['get']))
    expect(reads.length).toBeGreaterThan(0)

    const limitedReads = reads.filter((route) =>
      route.handlers.some(
        (handler) =>
          (handler as unknown as Record<symbol, unknown>)[RATE_LIMITER_MARK] ===
          RATE_LIMITS.authenticatedWrite.name
      )
    )
    expect(limitedReads).toEqual([])
  })
})
