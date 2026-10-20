/**
 * @file The mode gate for passkey routes. `PASSKEY_MODE=off` hides them all.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isPasskeyEnabled } from '@/configs/passkey.config'
import { notFoundError } from '@/errors/not-found-errors'

/**
 * Let a request through only when passkeys are on. With `PASSKEY_MODE=off`
 * the route answers the same 404 as an unknown path, and stored passkeys
 * stay untouched. Every passkey route except the settings read runs it first.
 * @param _request - The request, unused.
 * @param _response - The response, unused.
 * @param next - Continues, or carries the 404.
 */
export const requirePasskeysEnabled: RequestHandler = (
  _request: Request,
  _response: Response,
  next: NextFunction
) => {
  if (!isPasskeyEnabled()) {
    next(notFoundError('route'))
    return
  }
  next()
}
