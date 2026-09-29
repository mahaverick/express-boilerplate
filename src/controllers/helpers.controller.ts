/**
 * @file Request accessors shared by every controller: the authenticated user
 * id, the `Actor` a service call takes instead of a Request, the tenant
 * principal for `/tenants/:slug` handlers, and the frontend a Google sign-in
 * started from.
 */
import type { Request } from 'express'
import { isFrontendApp, type FrontendApp } from '@/constants/frontend.constants'
import { HttpError } from '@/errors/http-error'
import type { Actor, RequestPrincipal } from '@/types/actor'

/**
 * The authenticated principal's id, guarding against a route reaching a
 * controller without `requireAuth` ahead of it.
 * @param request - The incoming request.
 * @returns The authenticated user's id.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
export function authenticatedUserId(request: Request): string {
  if (!request.user) {
    throw new HttpError('Authentication required', 401)
  }
  return request.user.id
}

/**
 * The authenticated caller, as the `Actor` a service call takes.
 * @param request - The incoming request.
 * @returns The caller's Actor.
 * @throws {HttpError} 401, when `request.user` was never populated.
 */
export function actorFrom(request: Request): Actor {
  return { userId: authenticatedUserId(request) }
}

/**
 * The caller's tenant-scoped principal, guarding against a route reaching a
 * controller without `resolveTenant` ahead of it.
 * @param request - The incoming request.
 * @returns The caller's principal for the tenant the route names.
 * @throws {HttpError} 404, when `request.principal` was never populated, which is the answer a caller with no access gets.
 */
export function tenantPrincipal(request: Request): RequestPrincipal {
  if (!request.principal) {
    throw new HttpError('Tenant not found', 404)
  }
  return request.principal
}

/**
 * The frontend a Google callback should return to.
 * @param request - The callback request, after the OAuth session middleware.
 * @returns The stored app, or 'web' when there is none or it is not a known value.
 */
export function oauthAppOf(request: Request): FrontendApp {
  // The session store is server-side, but a value read back is still checked, never trusted.
  const stored: unknown = (request as Partial<Request>).session?.oauthApp
  return isFrontendApp(stored) ? stored : 'web'
}
