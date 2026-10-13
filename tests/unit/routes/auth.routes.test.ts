/**
 * @file The auth router's one staff route, `POST /reauthenticate`, answers a
 * refused caller what an unknown auth path answers: the router-wide JSON gate
 * runs first for every path, an OPTIONS refusal follows it on the staff path,
 * and the route comes after both, with the role gate ahead of its limiter.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { authController } from '@/controllers/auth.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { refusePlatformOptions } from '@/middlewares/platform.middleware'
import { RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import { createAuthRouter } from '@/routes/auth.routes'

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
 * The index of the `POST /reauthenticate` route layer; throws when there is none.
 */
function reauthenticateIndex(layers: RouteLayer[]): number {
  const index = layers.findIndex(
    (layer) => layer.route?.path === '/reauthenticate' && layer.route.methods.post === true
  )
  if (index === -1) throw new Error('no POST /reauthenticate route')
  return index
}

/**
 * The index of the router-wide `requireJsonContentType` layer.
 */
function gateIndex(layers: RouteLayer[]): number {
  return layers.findIndex(
    (layer) => layer.route === undefined && layer.handle === requireJsonContentType
  )
}

describe('createAuthRouter: POST /reauthenticate', () => {
  it('mounts the router-wide JSON gate ahead of every route', () => {
    const layers = layersOf(createAuthRouter())
    const gateAt = gateIndex(layers)

    expect(gateAt).not.toBe(-1)
    expect(layers.slice(0, gateAt).some((layer) => layer.route !== undefined)).toBe(false)
  })

  it('refuses OPTIONS on the staff path right after the JSON gate', () => {
    const layers = layersOf(createAuthRouter())
    const refusalAt = layers.findIndex(
      (layer) => layer.route === undefined && layer.handle === refusePlatformOptions
    )

    expect(refusalAt).toBe(gateIndex(layers) + 1)
    expect(layers[refusalAt]?.match('/reauthenticate')).toBe(true)
    expect(layers[refusalAt]?.match('/login')).toBe(false)
  })

  it('registers the route after both, with requireAuth, the role gate, the limiter, then the handler', () => {
    const layers = layersOf(createAuthRouter())
    const routeAt = reauthenticateIndex(layers)
    const handlers = layers[routeAt]?.route?.stack.map(({ handle }) => handle)

    expect(routeAt).toBeGreaterThan(gateIndex(layers) + 1)
    expect(handlers).toHaveLength(4)
    expect(handlers?.[0]).toBe(requireAuth)
    // requirePlatformRole builds a fresh closure per route, so the role gate is known by what it is not.
    expect([requireAuth, requireJsonContentType]).not.toContain(handlers?.[1])
    expect(Object.hasOwn(handlers?.[1] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(Object.hasOwn(handlers?.[2] ?? {}, RATE_LIMITER_MARK)).toBe(true)
    expect(handlers?.[3]).toBe(authController.reauthenticate)
  })
})
