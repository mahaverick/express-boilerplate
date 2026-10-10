/**
 * @file `requireAllowedOriginWhenPresent`, the Origin check on the two auth
 * routes that read the refresh cookie (`/auth/refresh`, `/auth/logout`).
 */
import type { NextFunction, Request, Response } from 'express'
import { HttpError } from '@/errors/http-error'
import { isAllowedOrigin } from '@/utilities/origin.utilities'

/**
 * Machine-readable code identifying a request refused for its `Origin`,
 * carried in the error envelope's `code` field.
 */
const ORIGIN_NOT_ALLOWED_CODE = 'ORIGIN_NOT_ALLOWED'

/**
 * Refuse a request whose `Origin` is present and not one this API serves.
 *
 * `SameSite=Strict` withholds the refresh cookie only from cross-SITE
 * requests. A page on a sibling subdomain is same-site, so its body-less
 * `POST` (no preflight) arrives with the cookie and could log the user out
 * or rotate their session. Browsers send `Origin` on every POST, so a
 * refused origin here is answered 403 before the limiter or the handler
 * runs. Passed: no `Origin` (a non-browser client, which no browser CSRF
 * concerns), `Sec-Fetch-Site: same-origin` (a frontend served beside the
 * API under any host; a page cannot set a `Sec-` header), and every origin
 * `isAllowedOrigin` grants (`WEB_URL`, `APEX_URL`, `CORS_ALLOWED_ORIGINS`).
 * @param request - The incoming request.
 * @param _response - The response. Unused: a refusal travels via `next`.
 * @param next - Continues, or forwards the 403 to the terminal error handler.
 */
export function requireAllowedOriginWhenPresent(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const origin = request.get('origin')
  if (
    origin === undefined ||
    request.get('sec-fetch-site') === 'same-origin' ||
    isAllowedOrigin(origin)
  ) {
    next()
    return
  }
  next(new HttpError('Origin not allowed', 403, ORIGIN_NOT_ALLOWED_CODE))
}
