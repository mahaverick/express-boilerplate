/**
 * @file Request accessors shared by every controller: the authenticated user
 * id, the `Actor` a service call takes instead of a Request, the tenant
 * principal for `/tenants/:slug` handlers, and what a Google round-trip
 * started for. Also the refresh cookie, for every controller that signs a
 * browser in: reading the one the request carries, revoking the session it
 * names, and setting a freshly issued one. Its name, path and domain come
 * only from `refreshCookieSpec`.
 */
import type { CookieOptions, Request, Response } from 'express'
import { getEnv, isCookieSecure, type Env } from '@/configs/env.config'
import { refreshCookieSpec, type RefreshCookieSpec } from '@/constants/auth.constants'
import { isFrontendApp } from '@/constants/frontend.constants'
import { HttpError } from '@/errors/http-error'
import { revokeRefreshToken } from '@/services/session.service'
import type { Actor, RequestPrincipal } from '@/types/actor'
import type { OAuthIntent } from '@/types/oauth-intent'
import { redirectPathSchema } from '@/validators/redirect.validators'

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
 * The Google round-trip's stored intent, re-checked field by field: the
 * session store is server-side, but a value read back is still checked,
 * never trusted.
 * @param request - The callback request, after the OAuth session middleware.
 * @returns The stored sign-in, with an unknown app read as 'web' and an unsafe redirect dropped; a web sign-in when there is none or it is not one.
 */
export function oauthIntentOf(request: Request): OAuthIntent {
  const stored: unknown = (request as Partial<Request>).session?.oauthIntent
  if (typeof stored !== 'object' || stored === null) return { kind: 'sign_in', app: 'web' }
  const { kind, app, redirect } = stored as Record<string, unknown>
  if (kind !== 'sign_in') return { kind: 'sign_in', app: 'web' }
  const safeRedirect = redirectPathSchema.safeParse(redirect)
  return {
    kind: 'sign_in',
    app: isFrontendApp(app) ? app : 'web',
    ...(safeRedirect.success && { redirect: safeRedirect.data }),
  }
}

/**
 * The refresh cookie's name, path and domain for this deployment.
 * @param env - The validated environment.
 * @returns The current cookie's spec.
 */
export function currentRefreshCookie(env: Env): RefreshCookieSpec {
  return refreshCookieSpec({ COOKIE_SECURE: isCookieSecure(env), COOKIE_DOMAIN: env.COOKIE_DOMAIN })
}

/**
 * Cookie options for one refresh-cookie spec. A clear must repeat the path
 * and domain it was set with, or the browser keeps the original.
 * @param spec - The cookie.
 * @param env - The validated environment.
 * @param sameSite - The cookie's `SameSite` attribute.
 * @returns Options for `response.cookie` or `response.clearCookie`.
 */
export function refreshCookieOptions(
  spec: RefreshCookieSpec,
  env: Env,
  sameSite: 'strict' | 'lax'
): CookieOptions {
  return {
    httpOnly: true,
    secure: isCookieSecure(env),
    sameSite,
    path: spec.path,
    ...(spec.domain !== undefined && { domain: spec.domain }),
  }
}

/**
 * The value of the last cookie named `name` in the request, read off the raw
 * `Cookie` header because this API reads only its own refresh cookie and so
 * needs no cookie-parser.
 *
 * Takes the LAST value of that name. A browser can hold two, one per domain
 * scope, after `COOKIE_DOMAIN` is changed. It sends same-path cookies oldest
 * first (RFC 6265 §5.4, by creation time), so the last is the most recently
 * created one. That is the one set under the current scope, except after
 * `COOKIE_DOMAIN` is reverted to an earlier value: overwriting a cookie keeps
 * its original creation time (RFC 6265 §5.3 step 11.3), so the other scope's
 * cookie reads as newer, and refresh fails until the user logs in again or it
 * expires (REFRESH_TOKEN_TTL). Reading the first cookie instead would hand
 * the stale token to reuse detection after every domain change, which
 * revokes the live session.
 * @param request - The incoming request.
 * @param name - The cookie name.
 * @returns The value decoded as Express's `response.cookie` encoded it (`encodeURIComponent`), the raw value when it does not decode, or undefined when no cookie of that name was sent.
 */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie
  if (!header) return undefined

  const prefix = `${name}=`
  const match = header
    .split(';')
    .map((part) => part.trim())
    .findLast((part) => part.startsWith(prefix))
  if (!match) return undefined

  const rawValue = match.slice(prefix.length)
  try {
    return decodeURIComponent(rawValue)
  } catch {
    return rawValue
  }
}

/**
 * The refresh token to redeem: the current cookie's only, by the
 * newest-cookie rule (`readCookie`). Under COOKIE_SECURE the unprefixed
 * `refreshToken` is never read: a sibling subdomain or an on-path
 * attacker on plain http can plant it. The `__Host-` prefix stops both;
 * `__Secure-` (used with COOKIE_DOMAIN) stops only the plain-http planter,
 * since COOKIE_DOMAIN already trusts its subdomains. Without COOKIE_SECURE
 * the current name is the unprefixed one.
 * @param request - The incoming request.
 * @returns The raw refresh token, or undefined when the current cookie was not sent.
 */
export function readRefreshTokenCookie(request: Request): string | undefined {
  return readCookie(request, currentRefreshCookie(getEnv()).name)
}

/**
 * Revoke the session of the refresh token the request carries, if any.
 * Logout's revoke, and also run after a sign-in: a session the browser's
 * cookie pointed at would otherwise stay refreshable after the new cookie
 * replaces it, outlive the next logout, and never trip reuse detection. The
 * new session's token is never the one revoked: it is only in the response.
 * @param request - The request whose cookie names the session.
 * @param options - How the revoke is reported.
 * @param options.emitSignedOut - Whether a live revoke emits `user_signed_out`; default true. A sign-in passes false, since it is not the user signing out.
 * @returns Resolves once the presented token's session, if any, is revoked.
 */
export async function revokePresentedSession(
  request: Request,
  options: { emitSignedOut?: boolean } = {}
): Promise<void> {
  const rawToken = readRefreshTokenCookie(request)
  if (rawToken === undefined) return
  await revokeRefreshToken(rawToken, options)
}

/**
 * Without COOKIE_SECURE but with COOKIE_DOMAIN, when the request carried a
 * `refreshToken` cookie, clear its host-only form too: the browser may hold
 * that scope beside the current one, and either may be the one it sent.
 * `setRefreshTokenCookie` calls it before adding the new cookie, so a browser
 * that treats two scopes as one cookie keeps the new one. Under COOKIE_SECURE
 * it clears nothing.
 * @param request - The incoming request.
 * @param response - The response to add the clearing Set-Cookie line to.
 * @param env - The validated environment.
 */
export function clearHostOnlyPlainRefreshCookie(
  request: Request,
  response: Response,
  env: Env
): void {
  if (isCookieSecure(env) || env.COOKIE_DOMAIN === undefined) return
  const hostOnly = refreshCookieSpec({ COOKIE_SECURE: false })
  if (readCookie(request, hostOnly.name) === undefined) return
  response.clearCookie(hostOnly.name, refreshCookieOptions(hostOnly, env, 'strict'))
}

/**
 * Attach a freshly issued refresh token to the response as an httpOnly
 * cookie, named and scoped by `refreshCookieSpec`, after
 * `clearHostOnlyPlainRefreshCookie`.
 *
 * `sameSite: 'strict'` is the cookie half of this API's CSRF position
 * (SECURITY.md: Bearer access tokens plus `SameSite` cookies, no CSRF
 * middleware). It assumes the frontend and this API share a registrable
 * domain (eTLD+1). A deployment that splits them across different registrable
 * domains would need `SameSite=None; Secure` plus a CSRF token: refresh and
 * logout would then be cross-site `fetch` POSTs, and a browser sends a `'lax'`
 * cookie only on top-level safe navigations, so `'lax'` withholds it just as
 * `'strict'` does. `setOAuthRefreshTokenCookie` is the one caller that passes
 * `'lax'`.
 * @param request - The request, checked for a host-only plain cookie to clear.
 * @param response - The response to set the cookie on.
 * @param rawToken - The raw refresh token.
 * @param expiresAt - When the token expires.
 * @param sameSite - The cookie's `SameSite` attribute. Defaults to `'strict'`.
 */
export function setRefreshTokenCookie(
  request: Request,
  response: Response,
  rawToken: string,
  expiresAt: Date,
  sameSite: 'strict' | 'lax' = 'strict'
): void {
  const env = getEnv()
  clearHostOnlyPlainRefreshCookie(request, response, env)
  const spec = currentRefreshCookie(env)
  response.cookie(spec.name, rawToken, {
    ...refreshCookieOptions(spec, env, sameSite),
    expires: expiresAt,
  })
}
