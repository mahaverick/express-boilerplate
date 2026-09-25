// src/middlewares/request-context.middleware.ts
//
// Wraps each request in the AsyncLocalStorage context
// request-context.service.ts owns, so logger.service.ts can attach the
// request id to every log line — including from code with no `Request`
// object in scope. Must run immediately after requestId: it reads
// `request.id`.
import { type NextFunction, type Request, type Response } from 'express'
import { requestContextStore } from '@/services/request-context.service'

/**
 * Wrap the rest of the request in an AsyncLocalStorage context carrying the
 * request-id. Runs immediately after the requestId middleware in the chain.
 * @param request - The request (with `id` already set by requestId middleware).
 * @param _response - Unused.
 * @param next - Passes control into the ALS context.
 */
export function requestContext(request: Request, _response: Response, next: NextFunction): void {
  requestContextStore.run({ requestId: request.id }, next)
}
