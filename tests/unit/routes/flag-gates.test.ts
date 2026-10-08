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
  slash: boolean
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
 * The paths a middleware mounted with `use()` covers, relative to its router:
 * a single empty path for a bare `use()`. Express 5 keeps no pattern on the
 * layer, so each route of the same router and each known mount is offered to
 * `layer.match()`, and the part that matched (`layer.path`) is kept for every
 * one it matches, so a wildcard or param mount covers all of them whatever
 * the declaration order.
 * @param layer - A non-router `use()` layer.
 * @param stack - The router's layers, whose routes are the candidates.
 * @returns The covered paths, such as `/:slug/beta`; empty when no route or
 *   known mount sits under the layer.
 */
function useMountsOf(layer: StackLayer, stack: StackLayer[]): string[] {
  if (layer.slash) return ['']
  const candidates = [
    ...stack.flatMap((sibling) => (sibling.route ? [sibling.route.path] : [])),
    ...KNOWN_MOUNTS,
  ]
  const mounts = candidates.flatMap((candidate) =>
    layer.match(candidate) && layer.path !== undefined ? [layer.path] : []
  )
  return [...new Set(mounts)]
}

/**
 * The flag gates a router stack holds, with each route's full path, recursing
 * into mounted routers. A mount is found by asking `layer.match()` about each
 * known mount and checking the whole mount matched (`layer.path`). A
 * `resolveTenant()` mounted with `use()` on a path counts only for gates on
 * that path or below it, in this router (a nested router starts unresolved).
 * @param stack - A router's layers.
 * @param prefix - The mount path the layers sit under.
 * @param isResolved - Whether `resolveTenant()` already ran on every request that reaches this router.
 * @returns One entry per gate, noting whether `resolveTenant()` ran before it.
 * @throws {Error} When a router or a `use()` gate is mounted at an unknown path.
 */
function gatesIn(stack: StackLayer[], prefix: string, isResolved = false): FoundGate[] {
  const resolver = resolveTenant() as unknown as RequestHandler
  let hasResolvedHere = isResolved
  const resolvedPaths: string[] = []
  const isResolvedAt = (path: string): boolean =>
    hasResolvedHere ||
    resolvedPaths.some((resolved) => path === resolved || path.startsWith(`${resolved}/`))
  return stack.flatMap((layer) => {
    if (layer.route) {
      const { path, stack: handlers } = layer.route
      let isRouteResolved = isResolvedAt(path)
      return handlers.flatMap(({ handle }) => {
        if (handle === resolver) isRouteResolved = true
        const mark = (handle as unknown as Partial<Record<symbol, FlagGateMark>>)[FLAG_GATE_MARK]
        return mark === undefined
          ? []
          : [{ path: `${prefix}${path}`, mark, isAfterResolveTenant: isRouteResolved }]
      })
    }
    if (!Array.isArray(layer.handle.stack)) {
      const mark = (layer.handle as unknown as Partial<Record<symbol, FlagGateMark>>)[
        FLAG_GATE_MARK
      ]
      const isResolver = (layer.handle as unknown) === resolver
      if (mark === undefined && !isResolver) return []
      // A gate mounted with `use()` covers every route under its own path (the router's mount alone for a bare `use()`).
      const mountPaths = useMountsOf(layer, stack)
      if (mark === undefined) {
        if (mountPaths.includes('')) hasResolvedHere = true
        else resolvedPaths.push(...mountPaths)
        return []
      }
      if (mountPaths.length === 0) throw new Error('a gate is mounted at an unknown path')
      return mountPaths.map((mountPath) => ({
        path: `${prefix}${mountPath}`,
        mark,
        isAfterResolveTenant: isResolvedAt(mountPath),
      }))
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

describe('the walk and a use() layer with its own path', () => {
  it('accepts a tenant gate mounted with use() on a /:slug/... path after resolveTenant', () => {
    const router = Router()
    const inner = Router()
    inner.use('/:slug/beta', resolveTenant(), requireFlag('example_beta_page'))
    inner.get('/:slug/beta', noop)
    router.use('/tenants', inner)
    const gates = gatesIn(stackOf(router), '')
    expect(gates).toHaveLength(1)
    expect(misplaced(gates)).toEqual([])
  })

  it('reports a tenant gate mounted with use() on a path outside /:slug', () => {
    const router = Router()
    const inner = Router()
    inner.use('/beta', resolveTenant(), requireFlag('example_beta_page'))
    inner.get('/beta', noop)
    router.use('/tenants', inner)

    const gates = gatesIn(stackOf(router), '')
    expect(misplaced(gates)).toEqual([
      {
        path: '/tenants/beta',
        mark: { key: 'example_beta_page', shouldBeOn: true },
        isAfterResolveTenant: true,
      },
    ])
  })

  it('reports a gate whose resolveTenant was mounted on another path', () => {
    const router = Router()
    const inner = Router()
    inner.use('/:slug/other', resolveTenant())
    inner.get('/:slug/beta', requireFlag('example_beta_page'), noop)
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

  it('throws on a gate mounted with use() at a path no route or router sits under', () => {
    const router = Router()
    router.use('/nowhere', requireFlag('example_beta_page'))

    expect(() => gatesIn(stackOf(router), '')).toThrow('gate is mounted at an unknown path')
  })

  it.each([
    ['the pathed route first', ['/:slug/beta', '/list']],
    ['the other route first', ['/list', '/:slug/beta']],
  ])(
    'reports a wildcard use() gate that also covers a route outside /:slug, with %s',
    (_name, paths) => {
      const router = Router()
      const inner = Router()
      for (const path of paths) inner.get(path, noop)
      inner.use('/{*splat}', resolveTenant(), requireFlag('example_beta_page'))
      router.use('/tenants', inner)

      const gates = gatesIn(stackOf(router), '')
      const found = misplaced(gates).map(({ path }) => path)
      expect(found).toContain('/tenants/list')
      expect(found).not.toContain('/tenants/:slug/beta')
    }
  )

  it('records a param use() gate at the param path even when a literal route comes first', () => {
    const router = Router()
    const inner = Router()
    inner.get('/beta', noop)
    inner.get('/:slug/x', noop)
    inner.use('/:slug', resolveTenant(), requireFlag('example_beta_page'))
    router.use('/tenants', inner)

    const paths = gatesIn(stackOf(router), '').map(({ path }) => path)
    expect(paths).toContain('/tenants/:slug')
  })

  it('does not count a resolveTenant on /:slug/other for a gate on /:slug/otherwise', () => {
    const router = Router()
    const inner = Router()
    inner.get('/:slug/other', noop)
    inner.use('/:slug/other', resolveTenant())
    inner.get('/:slug/otherwise', requireFlag('example_beta_page'), noop)
    router.use('/tenants', inner)

    const gates = gatesIn(stackOf(router), '')
    expect(misplaced(gates)).toEqual([
      {
        path: '/tenants/:slug/otherwise',
        mark: { key: 'example_beta_page', shouldBeOn: true },
        isAfterResolveTenant: false,
      },
    ])
  })
})
