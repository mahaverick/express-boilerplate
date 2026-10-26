/**
 * @file Every /api/v1/platform route, one table: anonymous 401, non-staff
 * 404, below the route's role 404 (the same body as an unknown route, and
 * still a 404 with a stale sign-in on a step-up route), the route's role
 * admitted, and a stale sign-in refused on step-up routes. A completeness
 * check walks the platform router and its sub-routers, so a route added
 * without a row here fails CI (OWASP API5: every function gets an explicit
 * gate). The two bearer step-up routes on the auth router
 * (`/auth/step-up/link/request` and `/link/verify`) are open to every
 * signed-in user and have their own block: an OPTIONS must get exactly what
 * an unknown path on the auth router gets, and a non-staff caller reaches the
 * limiter and the handler.
 */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Response } from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { NOT_FOUND } from '@/errors/not-found-errors'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { createPlatformRouter } from '@/routes/platform.routes'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { grantSeats } from '../../helpers/billing'
import {
  createTrackedMessage,
  createTrackedSuppression,
  deleteTrackedEmailRows,
} from '../../helpers/email-messages'
import { makeStaff } from '../../helpers/platform-staff'
import { request } from '../../helpers/request'

// Apex has no experiment flag, so a real report could only answer 400, which logStaffWrites skips anyway; an empty key list lets the exemption be seen on a 204.
vi.mock('@/validators/flags.validators', () => ({ parseExposureKeys: () => [] }))

/**
 * An HTTP method a gate row exercises.
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

/**
 * One platform route and the gate it must have.
 */
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
  target?: 'user' | 'tenant' | 'email' | 'suppression' | 'plan'
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
  { method: 'get', path: '/stats', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/system/status', minRole: 'admin', requiresStepUp: false },
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
    path: '/users/:id/sign-in-link',
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
  // Step-up is decided per message in the service: a resend of an invitation needs it on any tenant.
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
  {
    method: 'get',
    path: '/tenants/:id/billing',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'get',
    path: '/tenants/:id/billing/history',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'get',
    path: '/tenants/:id/billing/events',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'get',
    path: '/tenants/:id/billing/subscriptions',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'get',
    path: '/tenants/:id/billing/invoices',
    minRole: 'viewer',
    requiresStepUp: false,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/billing/resync',
    minRole: 'manager',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/billing/extend-trial',
    minRole: 'manager',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/billing/grants',
    minRole: 'manager',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/billing/grants/:grantId/revoke',
    minRole: 'manager',
    requiresStepUp: true,
    target: 'tenant',
  },
  {
    method: 'post',
    path: '/tenants/:id/billing/cancel',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'tenant',
  },
  { method: 'get', path: '/plans', minRole: 'viewer', requiresStepUp: false },
  // A preview writes nothing and takes no reason, so it needs no step-up.
  {
    method: 'post',
    path: '/plans/:id/preview',
    minRole: 'admin',
    requiresStepUp: false,
    target: 'plan',
  },
  { method: 'patch', path: '/plans/:id', minRole: 'admin', requiresStepUp: true, target: 'plan' },
  {
    method: 'post',
    path: '/plans/:id/prices',
    minRole: 'admin',
    requiresStepUp: true,
    target: 'plan',
  },
  { method: 'get', path: '/billing-settings', minRole: 'viewer', requiresStepUp: false },
  { method: 'patch', path: '/billing-settings', minRole: 'admin', requiresStepUp: true },
  { method: 'get', path: '/billing/alerts', minRole: 'admin', requiresStepUp: false },
  { method: 'get', path: '/me/flags', minRole: 'viewer', requiresStepUp: false },
  // Exposure is telemetry: a REAUTH_REQUIRED here would silently lose it, so the route takes no step-up; it is neither audited nor logged as a staff write.
  {
    method: 'post',
    path: '/me/flags/exposures',
    minRole: 'viewer',
    requiresStepUp: false,
    isStaffWriteLogExempt: true,
  },
  { method: 'get', path: '/flags', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/flags/unregistered', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/flags/meta', minRole: 'viewer', requiresStepUp: false },
  { method: 'get', path: '/flags/evaluate', minRole: 'admin', requiresStepUp: false },
  { method: 'get', path: '/maintenance-mode', minRole: 'viewer', requiresStepUp: false },
  { method: 'put', path: '/maintenance-mode', minRole: 'owner', requiresStepUp: true },
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
  '/tenants/:id/billing',
] as const

/**
 * The part of an Express 5 router layer that the route walker reads.
 */
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

/**
 * Orders strings for `toSorted`.
 */
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
        'post /tenants/:id/billing/grants/:grantId/revoke',
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
  const ids = { user: '', tenant: '', email: '', suppression: '', grant: '', plan: '' }

  /**
   * A fresh verified user with a token for a sign-in at `authenticatedAt`, tracked for cleanup.
   */
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

  /**
   * A token for a fresh user holding platform `role` (none when undefined), signed in at
   * `authenticatedAt`.
   */
  async function tokenFor(
    role: MembershipRole | undefined,
    authenticatedAt?: Date
  ): Promise<string> {
    const { user, token } = await createUser(authenticatedAt)
    if (role !== undefined) await makeStaff(user.id, role)
    return token
  }

  /**
   * A row's request path, with `:id` and `:key` filled in.
   */
  function pathOf(row: GateRow): string {
    const id = row.target ? ids[row.target] : ''
    return `/api/v1/platform${row.path
      .replace(':id', () => id)
      .replace(':key', () => STEP_KEY)
      .replace(':grantId', () => ids.grant)}`
  }

  /**
   * Calls a row's route with an empty JSON body, enough to reach the gates without acting.
   */
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
    // A real grant id, so the revoke path names one; the controller parses the body first, so an admitted call answers its validation 400 either way.
    await grantSeats(tenant.id, 10)
    const [grant] = await sql<{ id: string }[]>`
      select id from tenant_entitlement_grants where tenant_id = ${tenant.id}`
    if (!grant) throw new Error('setup: the grant was not stored')
    ids.grant = grant.id
    const [plan] = await sql<{ id: string }[]>`select id from plans where key = 'free'`
    if (!plan) throw new Error('setup: the billing migration seeds the free plan')
    ids.plan = plan.id
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
        expect((response.body as { message?: string }).message).toBe(NOT_FOUND.route.message)
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

  describe.each([
    { path: '/api/v1/auth/step-up/link/request', limiter: RATE_LIMITS.stepUpLink },
    { path: '/api/v1/auth/step-up/link/verify', limiter: RATE_LIMITS.stepUpLink },
  ])('POST $path, a step-up route on the auth router', ({ path: STAFF_PATH, limiter }) => {
    /**
     * Headers that differ between any two responses, whatever the route.
     */
    const VOLATILE_HEADERS = new Set([
      'date',
      'x-request-id',
      'etag',
      'content-length',
      'connection',
      'keep-alive',
      'ratelimit-reset',
      'ratelimit-remaining',
    ])

    /**
     * One request a caller might send: its method, Content-Type and body text, and Origin.
     */
    interface RequestVariant {
      label: string
      method: 'post' | 'options'
      contentType?: string
      body?: string
      origin?: string
    }
    // An unknown key: every step-up body schema refuses it, so a staff caller gets a validation 400 and nothing is mailed or stored.
    const JSON_BODY: RequestVariant = {
      label: 'POST with a JSON body',
      method: 'post',
      contentType: 'application/json',
      body: '{"unexpected":"x"}',
    }
    const TEXT_BODY: RequestVariant = {
      label: 'POST with a text/plain body',
      method: 'post',
      contentType: 'text/plain',
      body: 'token=x',
    }
    /**
     * JSON, the three bodies a form can send, no body, and an OPTIONS from a
     * disallowed origin with and without a content type.
     */
    const VARIANTS: readonly RequestVariant[] = [
      JSON_BODY,
      TEXT_BODY,
      {
        label: 'POST with a urlencoded body',
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        body: 'token=x',
      },
      {
        label: 'POST with a multipart body',
        method: 'post',
        contentType: 'multipart/form-data; boundary=x',
        body: '--x--',
      },
      { label: 'POST with no body', method: 'post' },
      { label: 'OPTIONS from a disallowed origin', method: 'options', origin: DISALLOWED_ORIGIN },
      {
        label: 'OPTIONS from a disallowed origin with a text/plain type',
        method: 'options',
        origin: DISALLOWED_ORIGIN,
        contentType: 'text/plain',
      },
    ]

    /**
     * Sends one variant to `path`, with a bearer token unless `token` is undefined.
     */
    function send(
      path: string,
      token: string | undefined,
      variant: RequestVariant
    ): Promise<Response> {
      const pending = request(app)[variant.method](path)
      if (token !== undefined) pending.set('Authorization', `Bearer ${token}`)
      if (variant.origin !== undefined) pending.set('Origin', variant.origin)
      if (variant.contentType !== undefined) pending.set('Content-Type', variant.contentType)
      return variant.body === undefined ? pending : pending.send(variant.body)
    }

    /**
     * What a caller can compare between two responses: the status, the body
     * without its request id, and every header but the volatile ones.
     */
    function observable(response: Response): {
      status: number
      body: unknown
      headers: Record<string, unknown>
    } {
      const body = Object.fromEntries(
        Object.entries(response.body as Record<string, unknown>).filter(
          ([key]) => key !== 'requestId'
        )
      )
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => !VOLATILE_HEADERS.has(name))
      )
      return { status: response.status, body, headers }
    }

    /**
     * Sends one variant to the route and to an unknown sibling auth path, with the same token or none.
     */
    async function againstSibling(
      token: string | undefined,
      variant: RequestVariant
    ): Promise<{ route: Response; sibling: Response }> {
      const route = await send(STAFF_PATH, token, variant)
      // A truly unknown auth path, outside /step-up: it never meets refusePlatformOptions, so an OPTIONS comparison can fail.
      const sibling = await send(`/api/v1/auth/${randomUUID()}`, token, variant)
      return { route, sibling }
    }

    it.each(VARIANTS.filter((variant) => variant.method === 'options'))(
      'answers an anonymous caller exactly what an unknown auth path answers: $label',
      async (variant) => {
        const { route, sibling } = await againstSibling(undefined, variant)

        expect(observable(route)).toEqual(observable(sibling))
      }
    )

    it('admits a non-staff caller to the limiter and the handler: a validation 400 under the limiter headers', async () => {
      const response = await send(STAFF_PATH, await tokenFor(undefined), JSON_BODY)

      expect(response.status).toBe(400)
      expect(response.headers).toHaveProperty('ratelimit-limit')
    })

    it('answers a non-staff caller a text/plain body with the router-wide JSON gate', async () => {
      const response = await send(STAFF_PATH, await tokenFor(undefined), TEXT_BODY)

      expect(response.status).toBe(415)
    })

    it('answers a non-staff caller 429 past the limiter budget', async () => {
      const token = await tokenFor(undefined)
      for (let attempt = 0; attempt < limiter.limit; attempt += 1) {
        const within = await send(STAFF_PATH, token, JSON_BODY)
        expect(within.status).toBe(400)
      }

      const over = await send(STAFF_PATH, token, JSON_BODY)

      expect(over.status).toBe(429)
    })

    it('answers viewer a text/plain body with the router-wide JSON gate', async () => {
      const response = await send(STAFF_PATH, await tokenFor('viewer'), TEXT_BODY)

      expect(response.status).toBe(415)
      expect((response.body as { code?: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE')
    })

    it('admits viewer past every gate to the limiter and the handler', async () => {
      const response = await send(STAFF_PATH, await tokenFor('viewer'), JSON_BODY)

      // The handler's own validation 400, under the limiter's headers.
      expect(response.status).toBe(400)
      expect(response.headers).toHaveProperty('ratelimit-limit')
    })
  })
})
