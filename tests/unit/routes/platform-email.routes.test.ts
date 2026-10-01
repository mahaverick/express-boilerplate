/**
 * @file The staff email routes: the role gate first on every route, then
 * the shared search limiter. `/health` is registered before `/:id`.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import {
  createPlatformEmailRouter,
  createPlatformEmailSuppressionRouter,
} from '@/routes/platform-email.routes'

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

function layersOf(router: Router): RouteLayer[] {
  return router.stack as unknown as RouteLayer[]
}

function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  const layer = layersOf(router).find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

const sharedSearchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
const sharedWriteLimiter = createRateLimiter(RATE_LIMITS.platformWrite)
const limiters = { searchLimiter: sharedSearchLimiter, writeLimiter: sharedWriteLimiter }

describe('createPlatformEmailRouter', () => {
  it.each([
    ['get', '/'],
    ['get', '/health'],
    ['get', '/:id'],
    ['get', '/:id/preview'],
  ])('%s %s: role gate, then the shared search limiter, then the handler', (method, path) => {
    const handlers = handlersFor(createPlatformEmailRouter(limiters), method, path)

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })

  it('registers /health before /:id, so "health" is never parsed as an id', () => {
    const paths = layersOf(createPlatformEmailRouter(limiters)).map((layer) => layer.route?.path)

    expect(paths.indexOf('/health')).toBeLessThan(paths.indexOf('/:id'))
  })
})

describe('createPlatformEmailSuppressionRouter', () => {
  it('get /: role gate, then the shared search limiter', () => {
    const handlers = handlersFor(createPlatformEmailSuppressionRouter(limiters), 'get', '/')

    expect(handlers).toHaveLength(3)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })
})
