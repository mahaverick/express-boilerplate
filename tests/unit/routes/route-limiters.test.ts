// tests/unit/routes/route-limiters.test.ts
//
// Walks the live app's router stack (built the same way createApp() itself
// builds it — no route list is hardcoded here) and asserts every
// POST/PUT/PATCH/DELETE route either carries a rate limiter
// (RATE_LIMITER_MARK on one of its handlers) or is named on ALLOWLIST with
// a reason. Express 5 has no app._router (that was Express 4) — app.router
// is a lazy getter (application.js) over the standalone `router` package,
// untyped in @types/express, hence the local shapes and the one cast.
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { withMutatedModule } from '../../helpers/mutate'

const WRITE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete'])

interface RouteHandlerLayer {
  method?: string
  handle: RequestHandler
}

interface BuiltRoute {
  path: string
  stack: RouteHandlerLayer[]
}

interface RouterStackLayer {
  route?: BuiltRoute
  handle: RequestHandler & { stack?: RouterStackLayer[] }
}

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
 * built it.
 * @param stack - A router's own `.stack`, or a sub-router's.
 * @param methods - The lowercase HTTP methods to collect.
 * @param into - Accumulator, mutated in place.
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
 * The live app's routes matching `methods`, walked from `app.router` —
 * untyped in `@types/express@5.0.6` (Express 5 dropped app._router for a lazy
 * `router` getter; verified against the installed package, no equivalent
 * surfaced in the type declarations), hence this one local cast.
 * @param app - Return value of `createApp()`.
 * @param methods - The lowercase HTTP methods to collect.
 * @returns Every discovered route whose method is in `methods`.
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
 * The live app's write routes.
 * @param app - Return value of `createApp()`.
 * @returns Every discovered POST/PUT/PATCH/DELETE route.
 */
function writeRoutesOf(app: ReturnType<typeof createApp>): DiscoveredRoute[] {
  return routesOf(app, WRITE_METHODS)
}

function hasRateLimiter(handlers: RequestHandler[]): boolean {
  return handlers.some((handler) => Object.hasOwn(handler, RATE_LIMITER_MARK))
}

/**
 * Routes deliberately exempt from carrying any rate limiter, with why.
 * Empty today — every write route either has its own route-specific
 * limiter already, or gets `authenticatedWrite` — kept as a mechanism for
 * the next legitimate exception rather than removed.
 */
const ALLOWLIST: { method: string; path: string; reason: string }[] = []

function isAllowlisted(route: DiscoveredRoute): boolean {
  // eslint-disable-next-line sonarjs/no-empty-collection -- deliberately empty today; kept as a mechanism for the next legitimate exception rather than removed
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
