/**
 * @file Remembers what started a Google sign-in, in the OAuth session: the
 * frontend, so the callback redirects back to it and nowhere else, and a
 * same-origin path to land on there.
 */
import type { NextFunction, Request, Response } from 'express'
import { isFrontendApp } from '@/constants/frontend.constants'
import { redirectPathSchema } from '@/validators/redirect.validators'

/**
 * Store the sign-in intent in the OAuth session before Passport redirects to
 * Google. Anything but an exact 'apex' or 'web' in `?app=`, including a
 * repeated parameter, is 'web'. `?redirect=` is kept only when
 * `redirectPathSchema` accepts it; anything else is dropped, never answered
 * with a 400, since the start is a full-page navigation.
 * @param request - The `/auth/google` request, after the OAuth session middleware.
 * @param _response - Unused.
 * @param next - Continues to Passport.
 */
export function rememberOAuthApp(request: Request, _response: Response, next: NextFunction): void {
  const requested = request.query.app
  const redirect = redirectPathSchema.safeParse(request.query.redirect)
  request.session.oauthIntent = {
    kind: 'sign_in',
    app: isFrontendApp(requested) ? requested : 'web',
    ...(redirect.success && { redirect: redirect.data }),
  }
  next()
}
