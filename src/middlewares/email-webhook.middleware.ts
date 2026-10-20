/**
 * @file The provider gate on the email webhook route, ahead of its limiter:
 * an unknown or disabled provider gets the app's own 404, with no
 * `RateLimit-*` headers, so a response never reveals which adapters are
 * enabled.
 */
import { type NextFunction, type Request, type Response } from 'express'
import { notFoundError } from '@/errors/not-found-errors'
import { getEmailWebhookAdapter } from '@/services/email-webhook.service'

/**
 * Pass only a request whose `:provider` names an enabled adapter.
 * @param request - The request.
 * @param _response - Unused.
 * @param next - Passes control on, or forwards the 404.
 */
export function requireEnabledEmailWebhookProvider(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const { provider } = request.params
  if (typeof provider !== 'string' || getEmailWebhookAdapter(provider) === undefined) {
    next(notFoundError('route'))
    return
  }
  next()
}
