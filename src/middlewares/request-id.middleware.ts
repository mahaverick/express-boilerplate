// src/middlewares/request-id.middleware.ts
//
// Every response carries an id, and a caller-supplied one is honoured so a
// trace survives the hop from the frontend. `cors(corsOptions)` (app.ts) is
// mounted ahead of this, but its origin callback never passes an Error
// (cors.config.ts) — so this is still the first thing in the chain that can
// produce or observe one, and the error handler reading the header back off
// the response always finds one there.
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
