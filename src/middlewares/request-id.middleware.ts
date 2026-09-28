/**
 * @file Gives every response an `X-Request-Id`, except an allowed-origin
 * preflight, which `cors` (app.ts) answers before this runs. `cors` never
 * passes an Error (cors.config.ts), so the error handler always finds the
 * header on the response.
 */
import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response } from 'express'

/**
 * Header carrying the correlation id in both directions.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * Attach a correlation id to the request and response.
 *
 * A caller-supplied UUID is kept, so a trace survives the hop from the
 * frontend. Anything else is replaced: reflecting an arbitrary header into a
 * response and the logs invites log injection.
 * @param request - The request.
 * @param response - The response.
 * @param next - Passes control on.
 */
export function requestId(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.get(REQUEST_ID_HEADER)
  const id = supplied && UUID_PATTERN.test(supplied) ? supplied : randomUUID()

  request.id = id
  response.setHeader(REQUEST_ID_HEADER, id)
  next()
}
