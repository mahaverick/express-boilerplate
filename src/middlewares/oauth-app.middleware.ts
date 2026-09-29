/**
 * @file Remembers which frontend started a Google sign-in, in the OAuth
 * session, so the callback redirects back to it and nowhere else.
 */
import type { NextFunction, Request, Response } from 'express'
import { FRONTEND_APPS, type FrontendApp } from '@/constants/frontend.constants'

/**
 * Whether a value is one of FRONTEND_APPS.
 * @param value - Anything read from a query string or a session.
 * @returns True for 'web' or 'apex' exactly.
 */
function isFrontendApp(value: unknown): value is FrontendApp {
  return typeof value === 'string' && (FRONTEND_APPS as readonly string[]).includes(value)
}

/**
 * Store `?app=` in the OAuth session before Passport redirects to Google.
 * Anything but an exact 'apex' or 'web', including a repeated parameter, is 'web'.
 * @param request - The `/auth/google` request, after the OAuth session middleware.
 * @param _response - Unused.
 * @param next - Continues to Passport.
 */
export function rememberOAuthApp(request: Request, _response: Response, next: NextFunction): void {
  const requested = request.query.app
  request.session.oauthApp = isFrontendApp(requested) ? requested : 'web'
  next()
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
