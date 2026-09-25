// tests/integration/middlewares/tenant.middleware.test.ts
//
// Against the real per-worker Postgres database (tests/helpers/worker-
// database.ts), through a real Express dispatch — not a direct function
// call. A direct call (tests/unit/middlewares/tenant.middleware.test.ts)
// cannot prove that `requestContextStore.enterWith(...)` survives Express 5's
// own `next()` hop from `resolveTenant` into a downstream handler; this file
// builds a small standalone `express()` app per test (never `createApp()` —
// no `/tenants/*` route exists yet, that is Task 3's job) and drives it with
// supertest, the same bare-app pattern tests/integration/api/health.test.ts
// uses for its own "forwards a rejected promise" case.
//
// `requireAuth` itself is NOT exercised here — a stub middleware sets
// `request.user` directly from a real user id this file created, which is
// enough to prove `resolveTenant`'s own contract (it reads `request.user.id`,
// nothing about how it got there). Real `requireAuth` composition is proven
// once, end-to-end, by Task 3's `tests/integration/api/tenant.test.ts`.
import { randomUUID } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import { errorHandler } from '@/middlewares/error.middleware'
import { requestContext } from '@/middlewares/request-context.middleware'
import { requestId } from '@/middlewares/request-id.middleware'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'
import { TenantRepository, type CreateTenantInput } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { requestContextStore, type TenantContext } from '@/services/request-context.service'
import type { RequestPrincipal } from '@/types/actor'
import { request } from '../../helpers/request'

/**
 * The body the probe handler (`buildApp` below) responds with — what
 * `resolveTenant` attached to `request.principal` and to the `RequestContext`
 * ALS store's own `.tenant`, both, so a test can assert either without
 * `@typescript-eslint/no-unsafe-member-access` on supertest's `any`-typed
 * `response.body`. Same "cast the JSON body to a known interface" pattern
 * tests/integration/api/auth.test.ts's own `ApiEnvelope<TData>` uses, just
 * for a plain (non-enveloped) JSON body — this probe route is test-only
 * scaffolding, not a real endpoint, so it does not go through
 * `successResponse`.
 */
interface ProbeBody {
  principal: RequestPrincipal | undefined
  contextTenant: TenantContext | undefined
}

/**
 * The error envelope `errorHandler` (error.middleware.ts) sends for a
 * rejected `HttpError` — `{ success, message, statusCode, requestId }`
 * (`code`/`errors` are omitted here since `resolveTenant` never sets
 * either). Declared so the Ruling G test below can compare specific fields
 * without `@typescript-eslint/no-unsafe-member-access` on supertest's
 * `any`-typed `response.body` — same reasoning as `ProbeBody` above.
 */
interface ErrorEnvelope {
  success: boolean
  message: string
  statusCode: number
  requestId: string
}

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * A disposable email, unique to one test run.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `tenant-middleware-${randomUUID()}@example.test`
}

/**
 * A disposable slug, unique to one test run.
 * @returns A slug guaranteed unique to this call.
 */
function uniqueSlug(): string {
  return `tenant-${randomUUID()}`
}

/**
 * Sets `request.user` from a real user id, standing in for `requireAuth` —
 * see this file's header comment for why the real middleware is not
 * exercised here.
 * @param userId - The user id to attach.
 * @returns An Express middleware.
 */
function stubAuthenticatedUser(userId: string) {
  return (thisRequest: Request, _response: Response, next: NextFunction): void => {
    thisRequest.user = {
      id: userId,
      email: 'stub@example.test',
      // eslint-disable-next-line unicorn/no-null -- AuthenticatedUser.firstName/lastName are `string | null`.
      firstName: null,
      // eslint-disable-next-line unicorn/no-null -- see comment above.
      lastName: null,
    }
    next()
  }
}

/**
 * The probe handler mounted at the end of every chain `buildApp` builds —
 * reports what the middleware chain ahead of it attached, so a test can
 * assert both `request.principal` and the ALS store's `.tenant` without a
 * second round trip. Only ever reached once `resolveTenant` (and, where
 * composed, `requireRole`) has already called `next()`, so `request.principal`
 * is always set here — never the `undefined` half of its type.
 * @param thisRequest - The incoming request, already carrying `.principal`.
 * @param response - The response to write the probe body to.
 */
function probe(thisRequest: Request, response: Response): void {
  response.json({
    principal: thisRequest.principal,
    contextTenant: requestContextStore.getStore()?.tenant,
  } satisfies ProbeBody)
}

/**
 * Build a standalone app wiring `requestId` -> `requestContext` ->
 * `stubAuthenticatedUser` (when `userId` is given) -> `resolveTenant` ->
 * (optionally) `requireRole` -> `probe`, on `/tenants/:slug/probe`, the
 * same shape every real `/tenants/:slug/*` route uses.
 * @param userId - The user id `resolveTenant` should see as `request.user.id`, or undefined to simulate a route missing `requireAuth`.
 * @param roles - When given, `requireRole(...roles)` is composed after `resolveTenant`.
 * @returns A configured Express app, not listening.
 */
function buildApp(userId: string | undefined, roles?: MembershipRole[]): Express {
  const app = express()
  app.use(requestId)
  app.use(requestContext)
  if (userId) app.use(stubAuthenticatedUser(userId))

  const chain = roles ? [resolveTenant(), requireRole(...roles)] : [resolveTenant()]

  app.get('/tenants/:slug/probe', ...chain, probe)
  app.use(errorHandler)
  return app
}

describe('resolveTenant + requireRole (integration)', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) {
      return
    }

    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh, disposable user, tracked for cleanup.
   * @returns The created user's id.
   */
  async function createUser(): Promise<string> {
    const user = await userRepository.create({ email: uniqueEmail() })
    createdUserIds.push(user.id)
    return user.id
  }

  /**
   * A fresh tenant with `ownerId` as its owner, tracked for cleanup.
   * @param ownerId - The user who becomes this tenant's owner.
   * @param overrides - Any `CreateTenantInput` fields to override.
   * @returns The created tenant row.
   */
  async function createTenant(ownerId: string, overrides: Partial<CreateTenantInput> = {}) {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: uniqueSlug(),
      ownerId,
      ...overrides,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  it('resolves a tenant from the :slug param and attaches request.principal + the ALS tenant context', async () => {
    const ownerId = await createUser()
    const tenant = await createTenant(ownerId)
    const app = buildApp(ownerId)

    const response = await request(app).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      principal: { tenantId: tenant.id, tenantSlug: tenant.slug, role: 'owner' },
      contextTenant: { tenantId: tenant.id, tenantSlug: tenant.slug, role: 'owner' },
    })
  })

  it('produces the SAME 404 body for a nonexistent tenant and for a real tenant the caller is not a member of (Ruling G)', async () => {
    const ownerId = await createUser()
    const outsiderId = await createUser()
    const tenant = await createTenant(ownerId)
    const outsiderApp = buildApp(outsiderId)

    const nonexistentResponse = await request(outsiderApp).get(`/tenants/${uniqueSlug()}/probe`)
    const nonMemberResponse = await request(outsiderApp).get(`/tenants/${tenant.slug}/probe`)
    const nonexistentBody = nonexistentResponse.body as ErrorEnvelope
    const nonMemberBody = nonMemberResponse.body as ErrorEnvelope

    expect(nonexistentResponse.status).toBe(404)
    expect(nonMemberResponse.status).toBe(404)
    // `requestId` is deliberately excluded from this comparison: it is a
    // per-request correlation id (requestId middleware), unrelated to
    // tenant existence, and differs between ANY two requests — even two
    // identical calls for the same nonexistent slug. Sanity-checked below
    // to prove these really are two distinct requests, not a caching bug
    // masking a real difference.
    expect(nonexistentBody.requestId).not.toBe(nonMemberBody.requestId)
    expect({
      success: nonMemberBody.success,
      message: nonMemberBody.message,
      statusCode: nonMemberBody.statusCode,
    }).toEqual({
      success: nonexistentBody.success,
      message: nonexistentBody.message,
      statusCode: nonexistentBody.statusCode,
    })
  })

  it('404s for a suspended tenant exactly like a nonexistent one', async () => {
    const ownerId = await createUser()
    const tenant = await createTenant(ownerId)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenant.id}`
    const app = buildApp(ownerId)

    const response = await request(app).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(404)
  })

  it('404s without crashing when the route is missing requireAuth (no request.user)', async () => {
    const ownerId = await createUser()
    const tenant = await createTenant(ownerId)
    const app = buildApp(undefined)

    const response = await request(app).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(404)
  })

  it('requireRole lets an allowed role through', async () => {
    const ownerId = await createUser()
    const tenant = await createTenant(ownerId)
    const app = buildApp(ownerId, ['owner', 'admin'])

    const response = await request(app).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(200)
  })

  it('requireRole rejects a disallowed role with 403, after resolveTenant already succeeded', async () => {
    const ownerId = await createUser()
    const viewerId = await createUser()
    const tenant = await createTenant(ownerId)
    await userMembershipRepository.create({ userId: viewerId, tenantId: tenant.id, role: 'viewer' })
    const app = buildApp(viewerId, ['owner', 'admin'])

    const response = await request(app).get(`/tenants/${tenant.slug}/probe`)

    expect(response.status).toBe(403)
  })
})
