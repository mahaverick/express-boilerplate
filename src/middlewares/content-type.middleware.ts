// src/middlewares/content-type.middleware.ts
//
// One middleware, `requireJsonContentType`, mounted on the auth router
// (auth.routes.ts). It exists for a CSRF reason, not an API-tidiness one.
//
// THE ATTACK IT CLOSES. app.ts mounts `express.urlencoded()` globally, so
// before this, `POST /api/v1/auth/login` accepted a form-encoded body. An
// attacker's page could therefore auto-submit a cross-site form:
//
//   <form action="https://api.example.com/api/v1/auth/login" method="POST">
//     <input name="email" value="attacker@evil.test">
//     <input name="password" value="...">
//   </form>
//
// with no Origin check anywhere in the request's path. A cross-site form
// POST needs no CORS permission — the browser sends it and simply hides the
// response — and `sameSite: 'strict'` does not help here, because that
// governs when a cookie is SENT, not whether a cross-site response may SET
// one. The victim's browser stores the `Set-Cookie` from the reply, and the
// victim is now silently logged into the ATTACKER'S account: everything
// they do next (a document uploaded, a card saved, a search made) happens
// inside an account the attacker can log into and read. SECURITY.md's CSRF
// section reasoned carefully about the other direction — an attacker using
// a victim's credentials — and did not consider this one.
//
// WHY CONTENT TYPE, NOT AN ORIGIN CHECK. Both were on the table. A
// content-type allow-list wins here for three reasons:
//
//   1. An HTML form can only ever produce `application/x-www-form-urlencoded`,
//      `multipart/form-data` or `text/plain` — those three are exactly the
//      encodings the HTML spec permits — so refusing all of them removes
//      the entire form vector by construction.
//   2. Requiring `application/json` forces any cross-origin script to send
//      a CORS preflight (a non-simple content type). This API now DOES ship
//      CORS middleware (cors.config.ts) — an allowed origin gets a grant and
//      may proceed past this gate on its own merits, but a DISALLOWED
//      origin still gets no grant header at all, so its preflight fails and
//      the browser blocks the request before this middleware, or the
//      handler, ever runs. This gate's job was never "answer every
//      preflight" — it is "an HTML form, which sends no preflight at all,
//      cannot reach this route with a body this API will parse".
//   3. It needs no configuration of its own. An Origin allow-list would
//      have needed `WEB_URL` to be read and correct — true today, but this
//      gate stays content-type-based regardless, because it is the layer
//      that also has to hold for a same-origin deployment with no
//      allowlist at all.
//
// A Sec-Fetch-Site check was deliberately NOT layered on top. It would add
// a second mechanism with its own failure mode (absent on old browsers and
// on every non-browser client, so it must fail open) to cover a case this
// one already covers.
//
// A REQUEST WITH NO CONTENT TYPE AT ALL IS ALLOWED, on purpose. `/refresh`
// and `/logout` are legitimately called with no body whatsoever, and an
// untyped body is inert anyway: `express.json()` only parses
// `application/json` and `express.urlencoded()` only parses its own type,
// so an untyped body never reaches a validator — `request.body` stays empty
// and the handler answers 400 for the missing fields. There is nothing an
// attacker can smuggle through this gap that a validator will read.
import { type NextFunction, type Request, type Response } from 'express'
import { HttpError } from '@/middlewares/error.middleware'

// A request declaring no content type at all normalises to '' — see this
// file's header comment for why that is allowed rather than refused.
const ACCEPTED_MEDIA_TYPES = new Set(['', 'application/json'])

/**
 * Machine-readable code identifying a rejected request body encoding,
 * carried in the error envelope's `code` field (error.middleware.ts /
 * `HttpError`) — the same pattern `ACCESS_TOKEN_EXPIRED` and
 * `RATE_LIMITED` use, so a client can branch on this without matching on
 * `message`.
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
  // Sliced rather than `split(';')[0]`, which TypeScript types as possibly
  // undefined and would need a fallback branch no input can ever reach.
  const parametersAt = header.indexOf(';')
  const mediaType = parametersAt === -1 ? header : header.slice(0, parametersAt)
  return mediaType.trim().toLowerCase()
}

/**
 * Reject a request whose body is encoded as anything but JSON.
 *
 * Mounted on the auth router as a CSRF control, not a formatting
 * preference — see this file's header comment for the attack it closes and
 * why an Origin check was not chosen instead.
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
