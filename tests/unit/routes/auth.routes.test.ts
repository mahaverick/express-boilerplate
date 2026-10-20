/**
 * @file The auth router's step-up routes under `/step-up`, which any signed-in
 * user may call. An OPTIONS under `/step-up` answers what an unknown auth path answers: the router-wide
 * JSON gate runs first for every path, an OPTIONS refusal follows it on
 * `/step-up`, and each bearer route comes after both, with `requireAuth`,
 * then its limiter, with no role gate: any signed-in user may confirm it's
 * them. The two link routes share one
 * limiter instance. Google is configured for the whole file, before anything
 * reads the environment, so a Google step-up route would be mounted if one
 * existed.
 */
import type { RequestHandler, Router } from 'express'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { authController } from '@/controllers/auth.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { refusePlatformOptions } from '@/middlewares/platform.middleware'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createAuthRouter } from '@/routes/auth.routes'

vi.hoisted(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-client-secret')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

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
  handle: RequestHandler
  match(path: string): boolean
}

/**
 * The auth router's layers, in registration order.
 */
function layersOf(router: Router): RouteLayer[] {
  return router.stack as unknown as RouteLayer[]
}

/**
 * The index of one route's layer; throws when there is none.
 */
function routeIndex(layers: RouteLayer[], method: string, path: string): number {
  const index = layers.findIndex(
    (layer) => layer.route?.path === path && layer.route.methods[method] === true
  )
  if (index === -1) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return index
}

/**
 * One route's handlers, in order.
 */
function handlersOf(layers: RouteLayer[], method: string, path: string): RequestHandler[] {
  return layers[routeIndex(layers, method, path)]?.route?.stack.map(({ handle }) => handle) ?? []
}

/**
 * Whether a handler is a rate limiter built by `createRateLimiter`.
 */
function isLimiter(handler: RequestHandler | undefined): boolean {
  return Object.hasOwn(handler ?? {}, RATE_LIMITER_MARK)
}

/**
 * The index of the router-wide `requireJsonContentType` layer.
 */
function gateIndex(layers: RouteLayer[]): number {
  return layers.findIndex(
    (layer) => layer.route === undefined && layer.handle === requireJsonContentType
  )
}

const BEARER_STEP_UP_ROUTES = [
  { path: '/step-up/link/request', handler: authController.requestStepUpLink },
  { path: '/step-up/link/verify', handler: authController.verifyStepUpLink },
]

describe('createAuthRouter: the step-up routes', () => {
  it('mounts the router-wide JSON gate ahead of every route', () => {
    const layers = layersOf(createAuthRouter())
    const gateAt = gateIndex(layers)

    expect(gateAt).not.toBe(-1)
    expect(layers.slice(0, gateAt).some((layer) => layer.route !== undefined)).toBe(false)
  })

  it('refuses OPTIONS under /step-up right after the JSON gate', () => {
    const layers = layersOf(createAuthRouter())
    const refusalAt = layers.findIndex(
      (layer) => layer.route === undefined && layer.handle === refusePlatformOptions
    )

    expect(refusalAt).toBe(gateIndex(layers) + 1)
    for (const path of ['/step-up', '/step-up/link/request', '/step-up/link/verify']) {
      expect(layers[refusalAt]?.match(path)).toBe(true)
    }
    expect(layers[refusalAt]?.match('/login')).toBe(false)
    expect(layers[refusalAt]?.match('/google')).toBe(false)
  })

  it.each(BEARER_STEP_UP_ROUTES)(
    'registers POST $path after both, with requireAuth then the limiter and no role gate',
    ({ path, handler }) => {
      const layers = layersOf(createAuthRouter())
      const handlers = handlersOf(layers, 'post', path)

      expect(routeIndex(layers, 'post', path)).toBeGreaterThan(gateIndex(layers) + 1)
      expect(handlers[0]).toBe(requireAuth)
      expect(isLimiter(handlers[1])).toBe(true)
      expect(handlers).toHaveLength(3)
      expect(handlers.at(-1)).toBe(handler)
    }
  )

  it('mounts the two link routes on one shared limiter instance', () => {
    const layers = layersOf(createAuthRouter())

    expect(handlersOf(layers, 'post', '/step-up/link/request')[1]).toBe(
      handlersOf(layers, 'post', '/step-up/link/verify')[1]
    )
  })

  it('mounts no Google step-up route, with Google sign-in configured', () => {
    const layers = layersOf(createAuthRouter())
    const paths = layers.map((layer) => layer.route?.path)

    expect(paths).toContain('/google/callback')
    expect(paths).not.toContain('/step-up/google')
    expect(paths).not.toContain('/step-up/google/start')
  })

  it('mounts no /reauthenticate route', () => {
    const layers = layersOf(createAuthRouter())

    expect(layers.some((layer) => layer.route?.path === '/reauthenticate')).toBe(false)
  })
})
