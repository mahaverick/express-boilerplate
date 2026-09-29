/**
 * @file Remembers which frontend started a Google sign-in, in the OAuth
 * session, so the callback redirects back to it and nowhere else.
 */
import type { NextFunction, Request, Response } from 'express'
import { isFrontendApp } from '@/constants/frontend.constants'

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
