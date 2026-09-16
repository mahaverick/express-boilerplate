// src/middlewares/request-context.middleware.ts
//
// Carries the request-id from requestId (request-id.middleware.ts) into an
// AsyncLocalStorage context so logger.service.ts can attach it to every log
// line emitted while handling this request — including from code that has
// no `Request` object in scope at all (a repository, a service, a utility
// several calls deep). Must run immediately after requestId: it reads
// `request.id`, which requestId is what sets.
import { AsyncLocalStorage } from 'node:async_hooks'
import { type NextFunction, type Request, type Response } from 'express'

/**
 * Per-request data carried through `AsyncLocalStorage` for the lifetime of
 * one request.
 */
export interface RequestContext {
  requestId: string
}

/**
 * The store backing `requestContext` below. Exported so `logger.service.ts`
 * can read the current request's id without either module importing the
 * other's middleware/handler surface — and so tests can assert directly
 * against `getStore()`.
 */
export const requestContextStore = new AsyncLocalStorage<RequestContext>()

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
