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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { createPlatformRouter } from '@/routes/platform.routes'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  createTrackedMessage,
  createTrackedSuppression,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'
import { makeStaff } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

// Apex has no experiment flag yet, so a real report could only answer 400, which logStaffWrites skips anyway; an empty key list lets the exemption be seen on a 204.
vi.mock('@/validators/flags.validators', () => ({ parseExposureKeys: () => [] }))

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
  target?: 'user' | 'tenant' | 'email' | 'suppression'
  /**
   * A write that is telemetry, not a staff action: no step-up, and
   * `logStaffWrites` leaves no `Staff write` line for it.
   */
  isStaffWriteLogExempt?: boolean
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
  {
    method: 'get',
    path: '/tenants/:id/timeline',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'get',
    path: '/tenants/:id/errors',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'tenant',
  },
  { method: 'get', path: '/stats', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/system/status', minRole: 'admin', requiresStepUp: false },
  { method: 'get', path: '/audit-log', minRole: 'admin', requiresStepUp: false },
  { method: 'get', path: '/users', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/users/:id', minRole: 'viewer', requiresStepUp: false, target: 'user' },
  {
    method: 'get',
    path: '/users/:id/timeline',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
  {
    method: 'get',
    path: '/users/:id/errors',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'user',
  },
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
  { method: 'get', path: '/emails', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/emails/health', minRole: 'viewer', requiresStepUp: false },
  {
    method: 'get',
    path: '/emails/:id',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'email',
  },
  {
    method: 'get',
    path: '/emails/:id/preview',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'email',
  },
  // Step-up is per message (a platform-tenant invitation only), decided in the service.
  {
    method: 'post',
    path: '/emails/:id/resend',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'email',
  },
  { method: 'get', path: '/email-suppressions', minRole: 'viewer', requiresStepUp: false },
  {
    method: 'post',
    path: '/email-suppressions/:id/lift',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'suppression',
  },
  { method: 'get', path: '/onboarding/funnel', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/onboarding/tenants', minRole: 'viewer', requiresStepUp: false },
  {
    method: 'get',
    path: '/tenants/:id/onboarding',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  // No step-up: neither a reminder nor a manual completion grants access.
  {
    method: 'post',
    path: '/tenants/:id/onboarding/steps/:key/complete',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/onboarding/remind',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'tenant',
  },
  { method: 'get', path: '/me/flags', minRole: 'viewer', requiresStepUp: false },
  // Exposure is telemetry: a REAUTH_REQUIRED here would silently lose it, and it is not audited.
  {
    method: 'post',
    path: '/me/flags/exposures',
    minRole: 'viewer',
    requiresStepUp: false,
    isStaffWriteLogExempt: true,
  },
  { method: 'get', path: '/flags', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/flags/evaluate', minRole: 'admin', requiresStepUp: false },
]

/**
 * The step `:key` resolves to: a real tenant step, so an admitted call
 * reaches body validation rather than the unknown-step 404.
 */
const STEP_KEY = 'configure_settings'

const ROLES_BELOW: Record<MembershipRole, MembershipRole[]> = {
  viewer: [],
  editor: ['viewer'],
  manager: ['viewer', 'editor'],
  admin: ['viewer', 'editor', 'manager'],
  owner: ['viewer', 'editor', 'manager', 'admin'],
}
const ELEVEN_MINUTES_MS = 11 * 60 * 1000
/**
 * An origin `cors` grants nothing, so an OPTIONS carrying it passes `cors`
 * and reaches the routers. With no Origin, or an allowed one, `cors` answers
 * every OPTIONS itself (204, the same for every path) before any router.
 */
const DISALLOWED_ORIGIN = 'https://not-allowed.example'

const app = createApp()
const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()

/**
 * The mount points of the platform router's sub-routers. A sub-router mounted
 * anywhere else fails the completeness check, so its routes can't hide.
 * The walker checks this list at every depth, a sub-router's own mounts too.
 */
const SUB_ROUTER_MOUNTS = [
  '/users',
  '/emails',
  '/email-suppressions',
  '/onboarding',
  '/tenants/:id/onboarding',
] as const

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
  it('reads every sub-router under its mount, the one mounted on a tenant path included', () => {
    expect(registeredRoutes()).toEqual(
      expect.arrayContaining([
        'post /users/:id/purge',
        'get /emails/health',
        'post /email-suppressions/:id/lift',
        'get /onboarding/funnel',
        'get /tenants/:id/onboarding',
      ])
    )
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
  const ids = { user: '', tenant: '', email: '', suppression: '' }

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

  function pathOf(row: GateRow): string {
    const id = row.target ? ids[row.target] : ''
    return `/api/v1/platform${row.path.replace(':id', () => id).replace(':key', () => STEP_KEY)}`
  }

  function call(row: GateRow, token?: string): Promise<Response> {
    const path = pathOf(row)
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
    // A security notice: its detail and preview answer 200, and a resend never reaches a delegate.
    const message = await createTrackedMessage({
      templateKey: 'password_changed',
      senderClass: 'general',
    })
    ids.email = message.id
    const suppression = await createTrackedSuppression(`gate-${randomUUID()}@example.test`)
    ids.suppression = suppression.id
  })

  afterAll(async () => {
    await deleteTrackedEmailRows()
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
        expect(response.headers).not.toHaveProperty('ratelimit-limit')
      }
    }
  )

  it.each(ROUTES.filter((row) => row.method !== 'get'))(
    '$method $path: non-staff get 404, not 415, whatever the Content-Type',
    async (row) => {
      const token = await tokenFor(undefined)
      const path = pathOf(row)

      const textPlain = await request(app)
        [row.method](path)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'text/plain')
        .send('reason=x')
      const noBody = await request(app)[row.method](path).set('Authorization', `Bearer ${token}`)

      expect([textPlain.status, noBody.status]).toEqual([404, 404])
    }
  )

  it('answers a no-Origin OPTIONS on a platform route exactly as on an unknown path', async () => {
    const token = await tokenFor(undefined)
    const platform = await request(app)
      .options('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${token}`)
    const unknown = await request(app)
      .options('/api/v1/definitely-not-a-route')
      .set('Authorization', `Bearer ${token}`)

    expect(platform.status).toBe(unknown.status)
    expect(platform.headers).not.toHaveProperty('allow')
  })

  it.each(ROUTES)(
    '$method $path: OPTIONS gets 404 with no Allow header, for non-staff, below-role staff and $minRole alike',
    async (row) => {
      const path = pathOf(row)
      const roles: (MembershipRole | undefined)[] = [
        undefined,
        ...ROLES_BELOW[row.minRole],
        row.minRole,
      ]
      for (const role of roles) {
        const response = await request(app)
          .options(path)
          .set('Origin', DISALLOWED_ORIGIN)
          .set('Authorization', `Bearer ${await tokenFor(role)}`)
        expect({ role, status: response.status }).toEqual({ role, status: 404 })
        expect(response.headers).not.toHaveProperty('allow')
        expect((response.body as { message?: string }).message).toBe('Not found')
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

  it.each(ROUTES.filter((row) => row.isStaffWriteLogExempt === true))(
    '$method $path: an admitted, stale-signed-in call leaves no Staff write line',
    async (row) => {
      const info = vi.spyOn(logger, 'info')
      const stale = new Date(Date.now() - ELEVEN_MINUTES_MS)

      const response = await call(row, await tokenFor(row.minRole, stale))

      expect(response.status).toBe(204)
      expect(info.mock.calls.filter(([message]) => message === 'Staff write')).toEqual([])
      info.mockRestore()
    }
  )
})
