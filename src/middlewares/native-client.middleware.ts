/**
 * @file `resolveClientKind`, which tells a native app from a browser and
 * refuses the requests that mix the two. Mounted first on the auth and
 * invitation routers, ahead of every gate and limiter, so a refusal spends
 * no budget.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  GOOGLE_NATIVE_REFUSED_MESSAGE,
  NATIVE_CLIENT_HEADER,
  NATIVE_CLIENT_REFUSED,
  NATIVE_CLIENT_REFUSED_MESSAGE,
  REFRESH_TOKEN_IN_BODY,
  type ClientKind,
} from '@/constants/native-client.constants'
import { HttpError } from '@/errors/http-error'

/**
 * Whether the request carries a header that only a browser sends: `Origin`
 * in any form (including `null` and empty) or any `Sec-Fetch-*`.
 * @param request - The incoming request.
 * @returns True when a browser header is present.
 */
function hasBrowserHeaders(request: Request): boolean {
  if (request.headers.origin !== undefined) return true
  return Object.keys(request.headers).some((name) => name.startsWith('sec-fetch-'))
}

/**
 * Whether the parsed body is an object that carries a `refreshToken` key.
 * @param request - The incoming request.
 * @returns True when the key is present, whatever its value.
 */
function hasRefreshTokenInBody(request: Request): boolean {
  const body: unknown = request.body
  return typeof body === 'object' && body !== null && Object.hasOwn(body, 'refreshToken')
}

/**
 * Set `request.clientKind` from the `X-Client` header: exactly `native` is a
 * native app, anything else is a browser. A native request with browser
 * headers is a page pretending to be an app, so it is refused. A browser
 * request must never carry a refresh token in its body, since the cookie is
 * its only way to present one.
 * @param request - The incoming request.
 * @param _response - The response. Unused: a refusal travels via `next`.
 * @param next - Continues, or forwards the 400 to the terminal error handler.
 */
export const resolveClientKind: RequestHandler = (
  request: Request,
  _response: Response,
  next: NextFunction
): void => {
  const kind: ClientKind = request.get(NATIVE_CLIENT_HEADER) === 'native' ? 'native' : 'web'
  request.clientKind = kind
  if (kind === 'native' && hasBrowserHeaders(request)) {
    next(new HttpError(NATIVE_CLIENT_REFUSED_MESSAGE, 400, NATIVE_CLIENT_REFUSED))
    return
  }
  if (kind === 'web' && hasRefreshTokenInBody(request)) {
    next(
      new HttpError(
        "This request can't carry sign-in details in its body. Reload the page and try again.",
        400,
        REFRESH_TOKEN_IN_BODY
      )
    )
    return
  }
  next()
}

/**
 * Whether `resolveClientKind` marked the request as a native app's.
 * @param request - The incoming request.
 * @returns True for a native request.
 */
export function isNativeRequest(request: Request): boolean {
  return request.clientKind === 'native'
}

/**
 * Refuse a native request on the Google sign-in routes, whose redirects and
 * cookies a native app cannot follow. Mounted first on both, so a refusal
 * spends no limiter budget and writes no session.
 * @param request - The incoming request, after `resolveClientKind`.
 * @param _response - The response. Unused: a refusal travels via `next`.
 * @param next - Continues for a browser, or forwards the 400 to the terminal error handler.
 */
export const refuseNativeGoogleSignIn: RequestHandler = (
  request: Request,
  _response: Response,
  next: NextFunction
): void => {
  if (isNativeRequest(request)) {
    next(new HttpError(GOOGLE_NATIVE_REFUSED_MESSAGE, 400, NATIVE_CLIENT_REFUSED))
    return
  }
  next()
}
