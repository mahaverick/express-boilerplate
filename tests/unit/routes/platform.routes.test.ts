// tests/unit/routes/platform.routes.test.ts
//
// The role gate must run before the limiter: a limiter first would put
// RateLimit-* headers on the non-staff 404 and reveal the route.
import type { RequestHandler, Router } from 'express'
import { describe, expect, it } from 'vitest'
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
})
