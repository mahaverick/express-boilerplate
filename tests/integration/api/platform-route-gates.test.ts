/**
 * @file Every /api/v1/platform route, one table: anonymous 401, non-staff
 * 404, below the route's role 404 (the same body as an unknown route, and
 * still a 404 with a stale sign-in on a step-up route), the route's role
 * admitted, and a stale sign-in refused on step-up routes. A completeness
 * check walks the platform router and its sub-routers, so a route added
 * without a row here fails CI (OWASP API5: every function gets an explicit
 * gate).
 */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Response } from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { createPlatformRouter } from '@/routes/platform.routes'
import { sql } from '@/services/database.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { makeStaff } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

type Method = 'get' | 'post' | 'patch' | 'delete'

interface GateRow {
  method: Method
  /**
   * Express path under /platform, with `:id` where the route takes one.
   */
  path: string
  minRole: MembershipRole
  requiresStepUp: boolean
  /**
   * Which fixture `:id` resolves to.
   */
  target?: 'user' | 'tenant'
}

const ROUTES: readonly GateRow[] = [
  { method: 'get', path: '/tenants', minRole: 'viewer', requiresStepUp: false },
  {
    method: 'get',
    path: '/tenants/:id',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  { method: 'post', path: '/tenants', minRole: 'admin', requiresStepUp: false },
  {
    method: 'post',
    path: '/tenants/:id/owner-invitation',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/suspend',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/reactivate',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/archive',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/purge',
    minRole: 'owner',
    requiresStepUp: true,
    target: 'tenant',
  },
  { method: 'get', path: '/stats', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/audit-log', minRole: 'admin', requiresStepUp: false },
  { method: 'get', path: '/users', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/users/:id', minRole: 'viewer', requiresStepUp: false, target: 'user' },
  { method: 'post', path: '/users', minRole: 'admin', requiresStepUp: false },
  { method: 'patch', path: '/users/:id', minRole: 'admin', requiresStepUp: false, target: 'user' },
  {
    method: 'post',
    path: '/users/:id/deactivate',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'user',
  },
  {
    method: 'post',
    path: '/users/:id/reactivate',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
  {
    method: 'post',
    path: '/users/:id/sign-out',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
  {
    method: 'post',
    path: '/users/:id/password-setup',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
  {
    method: 'post',
    path: '/users/:id/resend-verification',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
  { method: 'delete', path: '/users/:id', minRole: 'admin', requiresStepUp: true, target: 'user' },
  {
    method: 'post',
    path: '/users/:id/purge',
    minRole: 'owner',
    requiresStepUp: true,
    target: 'user',
  },
]

const ROLES_BELOW: Record<MembershipRole, MembershipRole[]> = {
  viewer: [],
  editor: ['viewer'],
  manager: ['viewer', 'editor'],
  admin: ['viewer', 'editor', 'manager'],
  owner: ['viewer', 'editor', 'manager', 'admin'],
}
const ELEVEN_MINUTES_MS = 11 * 60 * 1000

const app = createApp()
const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()

/**
 * The mount points of the platform router's sub-routers. A sub-router mounted
 * anywhere else fails the completeness check, so its routes can't hide.
 */
const SUB_ROUTER_MOUNTS = ['/users'] as const

interface StackLayer {
  route?: { path: string; methods: Record<string, boolean> }
  handle: { stack?: StackLayer[] }
  path?: string
  match(path: string): boolean
}

/**
 * The routes a router stack registers, as `method path`, recursing into mounted
 * sub-routers (`/users`). Express 5's router (router@2) keeps one layer
 * per `router.<method>()` call, with `route.path` and a `route.methods` map. A
 * `use()` layer has no `route`, and its `handle.stack` is set only when it
 * mounts a router. Its mount path is not exposed, so it is found by asking
 * `layer.match()` about each known mount and checking that the whole mount
 * matched (`layer.path`): a router mounted at `/` matches every path with an
 * empty `layer.path`, so it counts as unknown too.
 * @param stack - A router's layers.
 * @param prefix - The mount path the layers sit under.
 * @returns One `method path` string per route.
 * @throws {Error} When a sub-router is mounted anywhere but a known mount.
 */
function routesIn(stack: StackLayer[], prefix: string): string[] {
  return stack.flatMap((layer) => {
    if (layer.route) {
      const { path, methods } = layer.route
      return Object.keys(methods).map((method) => `${method} ${prefix}${path === '/' ? '' : path}`)
    }
    if (!Array.isArray(layer.handle.stack)) return []
    const mount = SUB_ROUTER_MOUNTS.find(
      (candidate) => layer.match(candidate) && layer.path === candidate
    )
    if (mount === undefined) throw new Error('a platform sub-router is mounted at an unknown path')
    return routesIn(layer.handle.stack, `${prefix}${mount}`)
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
 * Every route the platform router registers, as `method path`.
 * @returns One `method path` string per route.
 */
function registeredRoutes(): string[] {
  return routesIn(stackOf(createPlatformRouter()), '')
}

const byText = (a: string, b: string): number => a.localeCompare(b)

describe('the platform route walker', () => {
  it('reads the /users sub-router under its mount', () => {
    expect(registeredRoutes()).toContain('post /users/:id/purge')
  })

  it.each(['/extra', '/'])('throws on a sub-router mounted at %s', (mount) => {
    const router = Router()
    const inner = Router()
    inner.get('/hidden', (_request, response) => {
      response.end()
    })
    router.use(mount, inner)

    expect(() => routesIn(stackOf(router), '')).toThrow('mounted at an unknown path')
  })
})

describe('/api/v1/platform route gates', () => {
  const userIds: string[] = []
  const tenantIds: string[] = []
  const ids = { user: '', tenant: '' }

  async function createUser(
    authenticatedAt: Date = new Date()
  ): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `gate-${randomUUID()}@example.test`,
      emailVerifiedAt: new Date(),
    })
    userIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID(), authenticatedAt) }
  }

  async function tokenFor(
    role: MembershipRole | undefined,
    authenticatedAt?: Date
  ): Promise<string> {
    const { user, token } = await createUser(authenticatedAt)
    if (role !== undefined) await makeStaff(user.id, role)
    return token
  }

  function call(row: GateRow, token?: string): Promise<Response> {
    const id = row.target ? ids[row.target] : ''
    const path = `/api/v1/platform${row.path.replace(':id', () => id)}`
    // An empty JSON body: enough to pass the content-type gate and fail validation, never to act.
    const pending = request(app)[row.method](path).set('Content-Type', 'application/json')
    const authed = token ? pending.set('Authorization', `Bearer ${token}`) : pending
    return row.method === 'get' ? authed : authed.send({})
  }

  beforeAll(async () => {
    // Throwaway targets: a verified non-staff user and a tenant owned by a second one.
    const { user: target } = await createUser()
    const { user: owner } = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Gate Co',
      slug: `gate-${randomUUID()}`,
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)
    ids.user = target.id
    ids.tenant = tenant.id
  })

  afterAll(async () => {
    await truncateAuditLogs()
    await sql`delete from tenants where id = any(${tenantIds})`
    await sql`delete from users where id = any(${userIds})`
  })

  it('has a row for every registered platform route, and none extra', () => {
    const inTable = ROUTES.map((row) => `${row.method} ${row.path}`).toSorted(byText)

    expect(registeredRoutes().toSorted(byText)).toEqual(inTable)
  })

  it.each(ROUTES)('$method $path: anonymous 401', async (row) => {
    const response = await call(row)
    expect(response.status).toBe(401)
  })

  it.each(ROUTES)("$method $path: non-staff get the app's own 404", async (row) => {
    const token = await tokenFor(undefined)
    const unknown = await request(app)
      .get('/api/v1/definitely-not-a-route')
      .set('Authorization', `Bearer ${token}`)

    const refused = await call(row, token)

    expect(refused.status).toBe(404)
    expect((refused.body as { message?: string }).message).toBe(
      (unknown.body as { message?: string }).message
    )
    expect(refused.headers).not.toHaveProperty('ratelimit-limit')
  })

  it.each(ROUTES.filter((row) => ROLES_BELOW[row.minRole].length > 0))(
    '$method $path: every role below $minRole gets 404',
    async (row) => {
      const roles = ROLES_BELOW[row.minRole]
      for (const role of roles) {
        const response = await call(row, await tokenFor(role))
        expect({ role, status: response.status }).toEqual({ role, status: 404 })
      }
    }
  )

  it.each(ROUTES.filter((row) => row.requiresStepUp))(
    '$method $path: a role below $minRole with a stale sign-in gets 404, not REAUTH_REQUIRED',
    async (row) => {
      const stale = new Date(Date.now() - ELEVEN_MINUTES_MS)
      const roles = ROLES_BELOW[row.minRole]
      for (const role of roles) {
        const response = await call(row, await tokenFor(role, stale))
        expect({ role, status: response.status }).toEqual({ role, status: 404 })
        expect((response.body as { code?: string }).code).not.toBe(REAUTH_REQUIRED_CODE)
      }
    }
  )

  it.each(ROUTES)('$method $path: $minRole is admitted', async (row) => {
    const response = await call(row, await tokenFor(row.minRole))

    // Admitted means past the gates: a 2xx, or the handler's own 400/409.
    expect([401, 403, 404]).not.toContain(response.status)
  })

  it.each(ROUTES.filter((row) => row.requiresStepUp))(
    '$method $path: a sign-in older than 10 minutes gets 401 REAUTH_REQUIRED',
    async (row) => {
      const stale = new Date(Date.now() - ELEVEN_MINUTES_MS)

      const response = await call(row, await tokenFor(row.minRole, stale))

      expect(response.status).toBe(401)
      expect((response.body as { code?: string }).code).toBe(REAUTH_REQUIRED_CODE)
    }
  )

  it.each(ROUTES.filter((row) => !row.requiresStepUp))(
    '$method $path: a stale sign-in is not asked to re-authenticate',
    async (row) => {
      const stale = new Date(Date.now() - ELEVEN_MINUTES_MS)

      const response = await call(row, await tokenFor(row.minRole, stale))

      expect((response.body as { code?: string }).code).not.toBe(REAUTH_REQUIRED_CODE)
    }
  )
})
