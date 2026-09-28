/**
 * @file Wraps each request in request-context.service.ts's AsyncLocalStorage
 * context, so logger.service.ts can attach the request id to every log line,
 * even from code with no `Request` in scope.
 */
import { type NextFunction, type Request, type Response } from 'express'
import { requestContextStore, type RequestContext } from '@/services/request-context.service'

/**
 * Wrap the rest of the request in an AsyncLocalStorage context carrying the
 * request-id, client address and user agent. Runs immediately after the
 * requestId middleware in the chain.
 * @param request - The request (with `id` already set by requestId middleware).
 * @param _response - Unused.
 * @param next - Passes control into the ALS context.
 */
export function requestContext(request: Request, _response: Response, next: NextFunction): void {
  const context: RequestContext = { requestId: request.id }
  if (request.ip !== undefined) context.ip = request.ip
  const userAgent = request.headers['user-agent']
  if (userAgent !== undefined) context.userAgent = userAgent
  requestContextStore.run(context, next)
}
