/**
 * @file `requireJsonContentType`, a CSRF control mounted on the auth router,
 * every mutating tenant route and both invitation routes: it stops a
 * cross-site HTML form from reaching those routes with a body this API
 * parses.
 */
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/errors/http-error'

/**
 * JSON, or no content type at all (normalised to `''`).
 */
const ACCEPTED_MEDIA_TYPES = new Set(['', 'application/json'])

/**
 * Machine-readable code identifying a rejected request body encoding,
 * carried in the error envelope's `code` field, so a client can branch on
 * it without matching on `message`.
 */
export const UNSUPPORTED_MEDIA_TYPE_CODE = 'UNSUPPORTED_MEDIA_TYPE'

/**
 * The media type of a request, lowercased, with any parameters
 * (`; charset=utf-8`) stripped.
 * @param request - The incoming request.
 * @returns The bare media type, or an empty string when the request declares none.
 */
function mediaTypeOf(request: Request): string {
  const header = request.headers['content-type']
  if (header === undefined) return ''
  const parametersAt = header.indexOf(';')
  const mediaType = parametersAt === -1 ? header : header.slice(0, parametersAt)
  return mediaType.trim().toLowerCase()
}

/**
 * Reject a request whose body is encoded as anything but JSON.
 *
 * The attack: app.ts mounts `express.urlencoded()` globally, so without this
 * an attacker's page could auto-submit a cross-site form to
 * `POST /auth/login` with the attacker's credentials. A form POST needs no
 * CORS permission, and `sameSite: 'strict'` governs when a cookie is sent,
 * not whether a cross-site response may set one, so the victim's browser
 * would store the refresh cookie and be signed in to the attacker's account.
 *
 * Content type rather than an Origin check: a form can only send
 * `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
 * so refusing them closes the form vector by construction; requiring JSON
 * forces a script on another origin through a CORS preflight, which a
 * disallowed origin fails; and it needs no configuration, so it also holds
 * on a same-origin deployment with no allow-list. A Sec-Fetch-Site check is
 * deliberately not added: it must fail open when absent and covers nothing
 * this does not.
 *
 * A request with no content type is allowed on purpose: `/refresh` and
 * `/logout` are called with no body, and an untyped body is never parsed, so
 * `request.body` stays empty and a validator answers 400. That also means a
 * body-less POST needs no preflight, and `SameSite=Strict` still attaches the
 * refresh cookie when the page is same-site (a sibling subdomain), so those
 * two routes add an Origin check (`requireAllowedOriginWhenPresent`,
 * origin.middleware.ts). The "no configuration" property above holds for
 * every other route; on those two a frontend's origin must be `WEB_URL`,
 * `APEX_URL` or listed in `CORS_ALLOWED_ORIGINS`, unless the browser marks
 * the request same-origin.
 * @param request - The incoming request.
 * @param _response - The response. Unused: a rejection travels via `next`.
 * @param next - Forwards the request onward, or the rejection to the terminal error handler.
 */
export function requireJsonContentType(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  if (ACCEPTED_MEDIA_TYPES.has(mediaTypeOf(request))) {
    next()
    return
  }
  next(
    new HttpError(
      'Unsupported content type. This endpoint accepts application/json only.',
      415,
      UNSUPPORTED_MEDIA_TYPE_CODE
    )
  )
}
