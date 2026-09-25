// src/controllers/base.controller.ts
//
// The one place a controller's error path is written. Each handler is an
// arrow-function field wrapped by `handle`, so it is bound to its instance
// and can be mounted as `router.get('/', someController.method)`.
import type { NextFunction, Request, Response } from 'express'
import { logger } from '@/services/logger.service'

/**
 * A route handler: what Express mounts, and what `handle` wraps.
 */
export type Handler = (
  request: Request,
  response: Response,
  next: NextFunction
) => void | Promise<void>

/**
 * Base class for every controller. Subclasses declare each route handler as
 * an arrow-function field assigned through `this.handle(...)`.
 */
export abstract class BaseController {
  /**
   * Wrap a handler so a sync throw or an async rejection reaches `next`.
   * It never sends a response. After headers were sent it still calls
   * `next(error)`: `errorHandler` (error.middleware.ts) then logs the
   * error redacted and destroys the socket.
   * @param handler - The handler to wrap.
   * @returns A handler that resolves once `handler` has settled and any error has been passed to `next`.
   */
  protected handle(handler: Handler): Handler {
    return async (request, response, next) => {
      try {
        await handler(request, response, next)
      } catch (error) {
        // The error itself is logged by errorHandler, redacted; this line only
        // marks that the response was already on the wire.
        if (response.headersSent) logger.warn('Handler failed after headers were sent')
        next(error)
      }
    }
  }
}
