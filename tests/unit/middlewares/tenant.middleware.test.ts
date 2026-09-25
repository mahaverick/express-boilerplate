// tests/unit/middlewares/tenant.middleware.test.ts
//
// Pure-logic coverage of resolveTenant's branching (found+member, not-found,
// found-but-not-member, missing identifier, missing request.user, reading
// the slug param) and requireRole's role check — both repositories' prototype
// methods spied on, no Docker/Postgres touched. Database-backed proof that
// `enterWith` survives Express's own `next()` dispatch through a real router
// lives in tests/integration/middlewares/tenant.middleware.test.ts, per this
// repo's unit/integration split (CLAUDE.md).
//
// `vi.spyOn(TenantRepository.prototype, 'findActiveBySlug')` etc., not
// `vi.mock('@/repositories/...')`: tenant.middleware.ts builds its own
// module-private `tenantRepository`/`userMembershipRepository` instances at
// import time — spying on the prototype reaches those already-constructed
// instances with a plain property assignment, no module re-mocking or
// `vi.hoisted()` plumbing needed. Same pattern and reasoning as
// tests/unit/workers/notification.worker.test.ts's own header comment.
// Importing the real repository classes does not touch Postgres:
// database.service.ts's `postgres(...)` client connects lazily on first
// query, and no test here ever lets the real implementation run.
import { type NextFunction, type Request, type Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { requireRole, resolveTenant } from '@/middlewares/tenant.middleware'
import type { AuthenticatedUser } from '@/presenters/user.presenter'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import * as auditService from '@/services/audit.service'
import { logger } from '@/services/logger.service'
import { requestContextStore } from '@/services/request-context.service'
import type { RequestPrincipal } from '@/types/actor'

/**
 * A fixed tenant row — only `id`/`slug` are read by `resolveTenant`, but the
 * full shape is built so `findActiveBySlugSpy.mockResolvedValue(...)` type-checks
 * against `Tenant`.
 */
const mockTenant: Tenant = {
  id: 'tenant-1',
  name: 'Acme Inc',
  slug: 'acme',
  // eslint-disable-next-line unicorn/no-null -- Tenant.description/logo/website are `T | null` database columns.
  description: null,
  // eslint-disable-next-line unicorn/no-null -- see comment above.
  logo: null,
  // eslint-disable-next-line unicorn/no-null -- see comment above.
  website: null,
  lifecycleState: 'active',
  isPlatform: false,
  // eslint-disable-next-line unicorn/no-null -- Tenant.deletedAt is a `Date | null` soft-delete column.
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

/**
 * A fixed membership row for `mockTenant` — only `role` is read by
 * `resolveTenant`.
 * @param role - The role this membership carries.
 * @returns A membership row for `mockTenant`/`mockUser`.
 */
function mockMembership(role: UserMembership['role']): UserMembership {
  return {
    id: 'membership-1',
    userId: 'user-1',
    tenantId: mockTenant.id,
    role,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

/**
 * The seeded platform tenant's row, as `findActiveBySlug` would return it.
 */
const mockPlatformTenant: Tenant = {
  ...mockTenant,
  id: 'platform-tenant',
  name: 'Platform',
  slug: 'platform',
  isPlatform: true,
}

/**
 * The principal `resolveTenant` attaches for a member of `mockTenant`.
 * @param role - The member's role.
 * @returns The expected principal.
 */
function memberPrincipal(role: MembershipRole): RequestPrincipal {
  return {
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    isPlatformTenant: false,
    role,
    memberRole: role,
    // eslint-disable-next-line unicorn/no-null -- a member's principal carries no platform role
    platformRole: null,
    access: 'member',
  }
}

const mockUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'owner@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
}

/**
 * Build a minimal mock request. `resolveTenant` only ever reads
 * `.params.slug`, `.user`, `.id`, and assigns `.principal` — same
 * minimal-mock approach as auth.middleware.test.ts's own `buildRequest`.
 * @param overrides - Which of `slug`/`user` to populate.
 * @param overrides.slug - The value `request.params.slug` should carry, or undefined to omit it.
 * @param overrides.user - The value `request.user` should carry, or undefined to simulate a route missing `requireAuth`.
 * @returns A mock request, mutable enough for `resolveTenant` to set `.principal` on it.
 */
function buildRequest(overrides: { slug?: string; user?: AuthenticatedUser } = {}): Request {
  return {
    id: 'req-1',
    params: overrides.slug === undefined ? {} : { slug: overrides.slug },
    user: overrides.user,
  } as unknown as Request
}

/**
 * Build a `next` spy whose recorded argument is inspectable as `unknown`
 * rather than `any` — same helper and reasoning as
 * auth.middleware.test.ts's own `mockNext`.
 * @returns The spy (cast to `NextFunction`) and the argument its most recent call recorded.
 */
function mockNext(): { next: NextFunction; lastCallArgument: () => unknown } {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, lastCallArgument: () => spy.mock.calls.at(-1)?.[0] }
}

const noResponse = {} as Response

/**
 * Build a minimal mock request carrying (or omitting) `request.principal` —
 * all `requireRole` ever reads.
 * @param role - The role `request.principal.role` should carry, or undefined to simulate `resolveTenant` never having run.
 * @returns A mock request.
 */
function buildPrincipalRequest(role?: string): Request {
  return {
    principal: role === undefined ? undefined : { tenantId: 'tenant-1', tenantSlug: 'acme', role },
  } as unknown as Request
}

describe('resolveTenant', () => {
  let findActiveBySlugSpy: MockInstance<typeof TenantRepository.prototype.findActiveBySlug>
  let findByUserAndTenantSpy: MockInstance<
    typeof UserMembershipRepository.prototype.findByUserAndTenant
  >
  let findPlatformRoleSpy: MockInstance<typeof UserMembershipRepository.prototype.findPlatformRole>
  let recordPlatformAccessSpy: MockInstance<typeof auditService.recordPlatformAccess>

  beforeEach(() => {
    findActiveBySlugSpy = vi.spyOn(TenantRepository.prototype, 'findActiveBySlug')
    findByUserAndTenantSpy = vi.spyOn(UserMembershipRepository.prototype, 'findByUserAndTenant')
    findPlatformRoleSpy = vi
      .spyOn(UserMembershipRepository.prototype, 'findPlatformRole')
      // eslint-disable-next-line unicorn/no-null -- not staff
      .mockResolvedValue(null)
    recordPlatformAccessSpy = vi
      .spyOn(auditService, 'recordPlatformAccess')
      .mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('attaches request.principal and enters the tenant into the ALS store on success', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(mockMembership('owner'))

    const request = buildRequest({ slug: 'acme', user: mockUser })
    let nextCallCount = 0
    let capturedTenant: unknown
    // Reads `getStore()` SYNCHRONOUSLY from inside `next` — the same way
    // Express calls the next middleware/handler synchronously right after
    // `resolveTenant` calls `enterWith`, so this sees the mutation exactly
    // the way real downstream code does. Reading `getStore()` from OUTSIDE
    // the awaited `resolveTenant()(...)` call instead — in the calling
    // function's OWN continuation, after the fact — captures a stale
    // pre-`enterWith` snapshot instead: that continuation's promise
    // reaction was linked to this async context before the inner
    // `enterWith` call ever ran, which is a real, working-as-designed
    // AsyncLocalStorage subtlety, not a bug in `resolveTenant` — verified
    // empirically while writing this test.
    const next: NextFunction = (): void => {
      nextCallCount++
      capturedTenant = requestContextStore.getStore()?.tenant
    }

    await requestContextStore.run({ requestId: 'req-1' }, () =>
      resolveTenant()(request, noResponse, next)
    )

    expect(nextCallCount).toBe(1)
    expect(request.principal).toEqual(memberPrincipal('owner'))
    expect(capturedTenant).toEqual({ tenantId: 'tenant-1', tenantSlug: 'acme', role: 'owner' })
    expect(findActiveBySlugSpy).toHaveBeenCalledWith('acme')
    expect(findByUserAndTenantSpy).toHaveBeenCalledWith('user-1', 'tenant-1')
  })

  it('preserves the existing requestId already in the ALS store, alongside the new tenant', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(mockMembership('viewer'))

    const request = buildRequest({ slug: 'acme', user: mockUser })
    // The WHOLE store, not just `.requestId` — a `{ requestId }`-only store
    // and the `enterWith`'d `{ requestId, tenant }` one both carry the same
    // `requestId`, so asserting on that field alone would pass whether or
    // not `enterWith` actually ran. Asserting the whole store proves BOTH
    // that the prior field survived the spread AND that `tenant` landed
    // alongside it — and is what would catch a future refactor back to
    // hand-listing `requestId` instead of spreading the current store.
    let capturedStore: unknown
    const next: NextFunction = (): void => {
      capturedStore = requestContextStore.getStore()
    }

    await requestContextStore.run({ requestId: 'original-request-id' }, () =>
      resolveTenant()(request, noResponse, next)
    )

    expect(capturedStore).toEqual({
      requestId: 'original-request-id',
      tenant: { tenantId: 'tenant-1', tenantSlug: 'acme', role: 'viewer' },
    })
  })

  it('404s with the same error for a tenant that does not exist', async () => {
    findActiveBySlugSpy.mockResolvedValue(undefined)

    const request = buildRequest({ slug: 'no-such-tenant', user: mockUser })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    // The membership lookup is never reached when the tenant itself was not
    // found — nothing to check membership against.
    expect(findByUserAndTenantSpy).not.toHaveBeenCalled()
    expect(request.principal).toBeUndefined()
  })

  it('404s with the SAME error (Ruling G) for a real tenant the caller is not a member of', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(undefined)

    const request = buildRequest({ slug: 'acme', user: mockUser })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    // Same message as the nonexistent-tenant case above — a caller must not
    // be able to distinguish the two by response shape (spec correction #2).
    expect((error as HttpError).message).toBe('Tenant not found')
    expect(request.principal).toBeUndefined()
    expect(findPlatformRoleSpy).toHaveBeenCalledWith('user-1')
    expect(recordPlatformAccessSpy).not.toHaveBeenCalled()
  })

  it('404s without crashing when request.user is missing (route misconfigured, missing requireAuth)', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)

    const request = buildRequest({ slug: 'acme' })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect(findByUserAndTenantSpy).not.toHaveBeenCalled()
  })

  it('404s when no identifier is supplied at all, without calling either repository', async () => {
    const request = buildRequest({ user: mockUser })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect(findActiveBySlugSpy).not.toHaveBeenCalled()
    expect(findByUserAndTenantSpy).not.toHaveBeenCalled()
  })

  it('reads request.params.slug', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(mockMembership('admin'))

    const request = buildRequest({ slug: 'acme', user: mockUser })
    const { next } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(findActiveBySlugSpy).toHaveBeenCalledWith('acme')
  })

  it('isolates the tenant context between two concurrent ALS frames — proves no second/shared store', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(mockMembership('owner'))

    let sawTenantInFrameA: unknown = 'not-yet-checked'
    let sawTenantInOtherFrame: unknown = 'not-yet-checked'
    // Same synchronous-inside-`next` read as the success test above — see
    // that test's own comment for why reading `getStore()` after an outer
    // `await` instead would capture a stale snapshot.
    const captureFrameA: NextFunction = (): void => {
      sawTenantInFrameA = requestContextStore.getStore()?.tenant
    }

    await Promise.all([
      requestContextStore.run({ requestId: 'frame-a' }, () => {
        const request = buildRequest({ slug: 'acme', user: mockUser })
        return resolveTenant()(request, noResponse, captureFrameA)
      }),
      requestContextStore.run({ requestId: 'frame-b' }, async () => {
        // Never calls resolveTenant in this frame at all — its own store
        // must never see frame-a's tenant, proving `enterWith` mutates only
        // the calling async context's store, not a shared/global one.
        await new Promise((resolve) => setTimeout(resolve, 5))
        sawTenantInOtherFrame = requestContextStore.getStore()?.tenant
      }),
    ])

    expect(sawTenantInFrameA).toEqual({ tenantId: 'tenant-1', tenantSlug: 'acme', role: 'owner' })
    expect(sawTenantInOtherFrame).toBeUndefined()
  })

  it('gives staff with no membership their platform role as the effective role, and records the visit', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(undefined)
    findPlatformRoleSpy.mockResolvedValue('admin')

    const request = buildRequest({ slug: 'acme', user: mockUser })
    let capturedTenant: unknown
    const next = vi.fn<(error?: unknown) => void>(() => {
      capturedTenant = requestContextStore.getStore()?.tenant
    })

    await requestContextStore.run({ requestId: 'req-1' }, () =>
      resolveTenant()(request, noResponse, next)
    )

    expect(next).toHaveBeenCalledWith()
    expect(request.principal).toEqual({
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      isPlatformTenant: false,
      role: 'admin',
      // eslint-disable-next-line unicorn/no-null -- staff reach this tenant with no membership
      memberRole: null,
      platformRole: 'admin',
      access: 'platform',
    })
    expect(capturedTenant).toEqual({ tenantId: 'tenant-1', tenantSlug: 'acme', role: 'admin' })
    expect(recordPlatformAccessSpy).toHaveBeenCalledWith({ userId: 'user-1' }, 'tenant-1', 'admin')
  })

  it('lets membership win for staff who are members, without reading the platform role', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(mockMembership('viewer'))
    findPlatformRoleSpy.mockResolvedValue('owner')

    const request = buildRequest({ slug: 'acme', user: mockUser })
    const { next } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(request.principal).toEqual(memberPrincipal('viewer'))
    expect(findPlatformRoleSpy).not.toHaveBeenCalled()
    expect(recordPlatformAccessSpy).not.toHaveBeenCalled()
  })

  it('404s on the platform tenant for a non-member without consulting the platform role', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockPlatformTenant)
    findByUserAndTenantSpy.mockResolvedValue(undefined)
    findPlatformRoleSpy.mockResolvedValue('owner')

    const request = buildRequest({ slug: 'platform', user: mockUser })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(404)
    expect((error as HttpError).message).toBe('Tenant not found')
    expect(findPlatformRoleSpy).not.toHaveBeenCalled()
    expect(request.principal).toBeUndefined()
  })

  it('still admits staff when the visit cannot be recorded, and logs a warning', async () => {
    findActiveBySlugSpy.mockResolvedValue(mockTenant)
    findByUserAndTenantSpy.mockResolvedValue(undefined)
    findPlatformRoleSpy.mockResolvedValue('viewer')
    recordPlatformAccessSpy.mockRejectedValue(new Error('audit insert failed'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const request = buildRequest({ slug: 'acme', user: mockUser })
    const { next, lastCallArgument } = mockNext()

    await resolveTenant()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
    expect(request.principal?.access).toBe('platform')
    expect(warn).toHaveBeenCalledWith(
      'Platform access audit failed',
      expect.objectContaining({ tenantId: 'tenant-1' })
    )
  })
})

describe('requireRole', () => {
  it('allows the request through when request.principal.role is in the allow-list', () => {
    const request = buildPrincipalRequest('admin')
    const { next, lastCallArgument } = mockNext()

    requireRole('owner', 'admin')(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
  })

  it('rejects with 403 when request.principal.role is not in the allow-list', () => {
    const request = buildPrincipalRequest('viewer')
    const { next, lastCallArgument } = mockNext()

    requireRole('owner', 'admin')(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(403)
  })

  it('rejects with 403 when request.principal is missing entirely (resolveTenant never ran)', () => {
    const request = buildPrincipalRequest()
    const { next, lastCallArgument } = mockNext()

    requireRole('owner')(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    const error = lastCallArgument()
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(403)
  })

  it('rejects with 403 when called with an empty allow-list, regardless of role', () => {
    const request = buildPrincipalRequest('owner')
    const { next, lastCallArgument } = mockNext()

    requireRole()(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((lastCallArgument() as HttpError).statusCode).toBe(403)
  })

  it('treats each listed role as a floor, so a higher role passes too', () => {
    const request = buildPrincipalRequest('owner')
    const { next, lastCallArgument } = mockNext()

    requireRole('admin')(request, noResponse, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(lastCallArgument()).toBeUndefined()
  })
})
