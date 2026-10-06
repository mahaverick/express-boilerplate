/**
 * @file Walks the versioned API router and finds every `requireFlag` gate by
 * its `FLAG_GATE_MARK`. A gate on a tenant-scoped flag must sit on a
 * `/tenants/:slug/…` route and run after `resolveTenant()`, which sets the
 * principal the flag's tenant group comes from; anywhere else, or ahead of
 * it, the gate would answer 404 for everyone. Synthetic routers prove the
 * checks fail on a misplaced gate.
 */
import { Router, type RequestHandler } from 'express'
import { describe, expect, it } from 'vitest'
import { flagEntry } from '@/constants/flags.constants'
import { FLAG_GATE_MARK, requireFlag, type FlagGateMark } from '@/middlewares/flag.middleware'
import { resolveTenant } from '@/middlewares/tenant.middleware'
import { createApiRouter } from '@/routes/index.routes'

interface StackLayer {
  route?: { path: string; stack: { handle: RequestHandler }[] }
  handle: { stack?: StackLayer[] }
  path?: string
  match(path: string): boolean
}

interface FoundGate {
  path: string
  mark: FlagGateMark
  isAfterResolveTenant: boolean
}

/**
 * Every mount path a feature router or sub-router uses under `/api/v1`.
 * A router mounted anywhere else makes the walk throw, so no gate can hide.
 */
const KNOWN_MOUNTS = [
  '/auth',
  '/profile',
  '/notifications',
  '/tenants',
  '/invitations',
  '/platform',
  '/flags',
  '/status',
  '/users',
  '/emails',
  '/email-suppressions',
  '/onboarding',
  '/tenants/:id/onboarding',
] as const

const noop: RequestHandler = (_request, response) => {
  response.end()
}

/**
 * The flag gates a router stack holds, with each route's full path, recursing
 * into mounted routers. A mount is found by asking `layer.match()` about each
 * known mount and checking the whole mount matched (`layer.path`).
 * @param stack - A router's layers.
 * @param prefix - The mount path the layers sit under.
 * @param isResolved - Whether `resolveTenant()` already ran on every request that reaches this router.
 * @returns One entry per gate, noting whether `resolveTenant()` ran before it.
 * @throws {Error} When a router is mounted at a path not in `KNOWN_MOUNTS`.
 */
function gatesIn(stack: StackLayer[], prefix: string, isResolved = false): FoundGate[] {
  const resolver = resolveTenant() as unknown as RequestHandler
  let hasResolvedHere = isResolved
  return stack.flatMap((layer) => {
    if (layer.route) {
      const { path, stack: handlers } = layer.route
      let isRouteResolved = hasResolvedHere
      return handlers.flatMap(({ handle }) => {
        if (handle === resolver) isRouteResolved = true
        const mark = (handle as unknown as Partial<Record<symbol, FlagGateMark>>)[FLAG_GATE_MARK]
        return mark === undefined
          ? []
          : [{ path: `${prefix}${path}`, mark, isAfterResolveTenant: isRouteResolved }]
      })
    }
    if (!Array.isArray(layer.handle.stack)) {
      if ((layer.handle as unknown) === resolver) hasResolvedHere = true
      // A gate mounted with `use()` covers every route below its router, so its path is the mount alone.
      const mark = (layer.handle as unknown as Partial<Record<symbol, FlagGateMark>>)[
        FLAG_GATE_MARK
      ]
      return mark === undefined
        ? []
        : [{ path: prefix, mark, isAfterResolveTenant: hasResolvedHere }]
    }
    const mount = KNOWN_MOUNTS.find(
      (candidate) => layer.match(candidate) && layer.path === candidate
    )
    if (mount === undefined) throw new Error('a router is mounted at an unknown path')
    return gatesIn(layer.handle.stack, `${prefix}${mount}`, hasResolvedHere)
  })
}

/**
 * The layers of a router built by `Router()`.
 * @param router - The router.
 * @returns Its stack.
 */
function stackOf(router: Router): StackLayer[] {
  return (router as unknown as { stack: StackLayer[] }).stack
}

/**
 * The gates on tenant-scoped flags that are not on a `/tenants/:slug/` route,
 * or that run before `resolveTenant()` on one.
 * @param gates - The gates found.
 * @returns The misplaced ones.
 */
function misplaced(gates: FoundGate[]): FoundGate[] {
  return gates.filter(
    ({ path, mark, isAfterResolveTenant }) =>
      flagEntry(mark.key).scope === 'tenant' &&
      !(isAfterResolveTenant && path.startsWith('/tenants/:slug/'))
  )
}

describe('requireFlag placement', () => {
  it('finds the reference gate on the tenant router', () => {
    const gates = gatesIn(stackOf(createApiRouter()), '')

    expect(gates).toContainEqual({
      path: '/tenants/:slug/beta',
      mark: { key: 'example_beta_page', shouldBeOn: true },
      isAfterResolveTenant: true,
    })
  })

  it('mounts every tenant-scoped gate under /tenants/:slug', () => {
    const gates = gatesIn(stackOf(createApiRouter()), '')

    expect(misplaced(gates)).toEqual([])
  })

  it('reports a tenant-scoped gate mounted outside the tenant router', () => {
    const router = Router()
    const inner = Router()
    inner.get('/beta', requireFlag('example_beta_page'), noop)
    router.use('/flags', inner)
    const gates = gatesIn(stackOf(router), '')

    expect(misplaced(gates)).toEqual([
      {
        path: '/flags/beta',
        mark: { key: 'example_beta_page', shouldBeOn: true },
        isAfterResolveTenant: false,
      },
    ])
  })

  it('reports a tenant-scoped gate mounted ahead of resolveTenant on a tenant route', () => {
    const router = Router()
    const inner = Router()
    inner.get('/:slug/beta', requireFlag('example_beta_page'), resolveTenant(), noop)
    router.use('/tenants', inner)
    const gates = gatesIn(stackOf(router), '')

    expect(misplaced(gates)).toEqual([
      {
        path: '/tenants/:slug/beta',
        mark: { key: 'example_beta_page', shouldBeOn: true },
        isAfterResolveTenant: false,
      },
    ])
  })

  it('reports a tenant-scoped gate mounted with use(), which covers routes outside /tenants/:slug', () => {
    const router = Router()
    const inner = Router()
    inner.use(resolveTenant(), requireFlag('example_beta_page'))
    inner.get('/:slug/beta', noop)
    router.use('/tenants', inner)
    const gates = gatesIn(stackOf(router), '')

    expect(misplaced(gates)).toEqual([
      {
        path: '/tenants',
        mark: { key: 'example_beta_page', shouldBeOn: true },
        isAfterResolveTenant: true,
      },
    ])
  })

  it('accepts a gate after resolveTenant, on the route or mounted earlier with use()', () => {
    const router = Router()
    const inner = Router()
    inner.get('/:slug/beta', resolveTenant(), requireFlag('example_beta_page'), noop)
    inner.use(resolveTenant())
    inner.get('/:slug/other', requireFlag('example_beta_page'), noop)
    router.use('/tenants', inner)
    const gates = gatesIn(stackOf(router), '')

    expect(gates).toHaveLength(2)
    expect(misplaced(gates)).toEqual([])
  })

  it('throws on a router mounted at an unknown path', () => {
    const router = Router()
    router.use('/hidden', Router())
    const stack = stackOf(router)

    expect(() => gatesIn(stack, '')).toThrow('mounted at an unknown path')
  })
})
