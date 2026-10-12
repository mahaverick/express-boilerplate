/**
 * @file The auth router's one staff route, `POST /reauthenticate`, runs its
 * gates in the staff order (role gate, JSON gate, limiter), registered ahead
 * of the router-wide JSON gate so a non-staff caller never sees a 415; the
 * router-wide gate still follows it for every other route, and an OPTIONS
 * refusal keeps Express's automatic `Allow` answer off the path.
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

describe('createAuthRouter: POST /reauthenticate', () => {
  it('runs requireAuth, the role gate, the JSON gate, the limiter, then the handler', () => {
    const layers = layersOf(createAuthRouter())
    const handlers = layers[reauthenticateIndex(layers)]?.route?.stack.map(({ handle }) => handle)

    expect(handlers).toHaveLength(5)
    expect(handlers?.[0]).toBe(requireAuth)
    // requirePlatformRole builds a fresh closure per route, so the role gate is the one handler here that is neither of the others.
    expect([requireAuth, requireJsonContentType]).not.toContain(handlers?.[1])
    expect(Object.hasOwn(handlers?.[1] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers?.[2]).toBe(requireJsonContentType)
    expect(Object.hasOwn(handlers?.[3] ?? {}, RATE_LIMITER_MARK)).toBe(true)
    expect(handlers?.[4]).toBe(authController.reauthenticate)
  })

  it('sits ahead of the router-wide JSON gate, which every other route still follows', () => {
    const layers = layersOf(createAuthRouter())
    const reauthenticateAt = reauthenticateIndex(layers)
    const gateAt = layers.findIndex(
      (layer) => layer.route === undefined && layer.handle === requireJsonContentType
    )
    const otherRoutesAt = layers.flatMap((layer, index) =>
      index !== reauthenticateAt && layer.route ? [index] : []
    )

    expect(gateAt).toBeGreaterThan(reauthenticateAt)
    expect(otherRoutesAt.length).toBeGreaterThan(0)
    expect(otherRoutesAt.every((index) => index > gateAt)).toBe(true)
  })

  it('refuses OPTIONS on the path with refusePlatformOptions, after the JSON gate and before any later route', () => {
    const layers = layersOf(createAuthRouter())
    const gateAt = layers.findIndex(
      (layer) => layer.route === undefined && layer.handle === requireJsonContentType
    )
    const refusalAt = layers.findIndex(
      (layer) => layer.route === undefined && layer.handle === refusePlatformOptions
    )

    expect(refusalAt).toBe(gateAt + 1)
    expect(layers[refusalAt]?.match('/reauthenticate')).toBe(true)
    expect(layers[refusalAt]?.match('/login')).toBe(false)
  })
})
