/**
 * @file The AsyncLocalStorage store that `requestContext` (request-context.middleware.ts)
 * opens with `.run()` and `resolveTenant` (tenant.middleware.ts) extends with
 * `.enterWith()`. It lives here so non-middleware code can read it without importing middlewares.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * The tenant a request is scoped to, and the caller's effective role in it,
 * once `resolveTenant` has resolved one. `request.principal`
 * (`RequestPrincipal`, types/actor.ts) carries the same three fields plus
 * how the caller reached the tenant.
 */
export interface TenantContext {
  tenantId: string
  tenantSlug: string
  role: MembershipRole
}

/**
 * Per-request data carried through `AsyncLocalStorage` for the lifetime of
 * one request. `tenant` is absent until (and unless) `resolveTenant` runs
 * and finds one.
 */
export interface RequestContext {
  requestId: string
  /**
   * The client address as Express resolves it under `trust proxy`.
   */
  ip?: string
  /**
   * The raw `User-Agent` header.
   */
  userAgent?: string
  tenant?: TenantContext
}

/**
 * The store backing `requestContext` (request-context.middleware.ts).
 * Exported so `logger.service.ts` can read the current request's id
 * without importing a middleware, and so tests can assert directly
 * against `getStore()`.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()
