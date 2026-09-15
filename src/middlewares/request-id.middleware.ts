// src/middlewares/request-id.middleware.ts
//
// Every response carries an id, and a caller-supplied one is honoured so a
// trace survives the hop from the frontend. This runs first in the chain:
// the error handler reads the header back off the response, so anything
// registered before this would produce errors with no id.
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
 * A caller-supplied id is validated before it is echoed — reflecting an
 * arbitrary header into a response is how a log-injection bug starts.
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
