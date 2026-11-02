/**
 * @file Remembers what started a Google sign-in, in the OAuth session: the
 * frontend, so the callback redirects back to it and nowhere else, and a
 * same-origin path to land on there.
 */
import type { NextFunction, Request, Response } from 'express'
import { isFrontendApp } from '@/constants/frontend.constants'
import { frontendUrl } from '@/services/frontend-links.service'
import { redirectPathSchema } from '@/validators/redirect.validators'

/**
 * Send a sign-in started from another site to the login page, before it writes
 * a session or leaves for Google. Both frontends start one from their own
 * site, and Google may approve with no prompt, so another site's navigation
 * could otherwise switch the browser's account. A browser sends this header
 * and a page cannot set it; a client without it is no browser to protect.
 * @param request - The `/auth/google` request.
 * @param response - Receives the redirect.
 * @param next - Continues to the sign-in.
 */
export function refuseCrossSiteOAuthStart(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  if (request.get('sec-fetch-site') !== 'cross-site') {
    next()
    return
  }
  const requested = request.query.app
  const frontend = frontendUrl(isFrontendApp(requested) ? requested : 'web')
  response.redirect(new URL('login', frontend.endsWith('/') ? frontend : `${frontend}/`).href)
}

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
