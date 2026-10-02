/**
 * @file The staff onboarding routes: the role gate first on every route,
 * then the shared search limiter on reads. No route takes a step-up gate.
 */
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { createRateLimiter, RATE_LIMITER_MARK } from '@/middlewares/rate-limit.middleware'
import {
  createPlatformOnboardingRouter,
  createPlatformTenantOnboardingRouter,
} from '@/routes/platform-onboarding.routes'

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: RequestHandler }>
  }
}

function handlersFor(router: Router, method: string, path: string): RequestHandler[] {
  const layer = (router.stack as unknown as RouteLayer[]).find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method] === true
  )
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route`)
  return layer.route.stack.map((entry) => entry.handle)
}

const sharedSearchLimiter = createRateLimiter(RATE_LIMITS.platformSearch)
const sharedWriteLimiter = createRateLimiter(RATE_LIMITS.platformWrite)
const limiters = { searchLimiter: sharedSearchLimiter, writeLimiter: sharedWriteLimiter }

describe('createPlatformOnboardingRouter', () => {
  it.each([
    ['get', '/funnel'],
    ['get', '/tenants'],
  ])('%s %s: role gate, then the shared search limiter, then the handler', (method, path) => {
    const handlers = handlersFor(createPlatformOnboardingRouter(limiters), method, path)

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })
})

describe('createPlatformTenantOnboardingRouter', () => {
  it('get /: role gate, then the shared search limiter, then the handler', () => {
    const handlers = handlersFor(createPlatformTenantOnboardingRouter(limiters), 'get', '/')

    expect(handlers).toHaveLength(3)
    expect(Object.hasOwn(handlers[0] ?? {}, RATE_LIMITER_MARK)).toBe(false)
    expect(handlers[1]).toBe(sharedSearchLimiter)
  })
})
