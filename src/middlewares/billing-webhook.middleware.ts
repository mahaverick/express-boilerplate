/**
 * @file The provider gate on the Razorpay webhook route, ahead of its
 * limiters: with payments off, or on the fake provider (which sends no
 * webhooks), the route answers the app's own unknown-route 404 with no
 * `RateLimit-*` headers, so a response never reveals the payment setup.
 */
import type { NextFunction, Request, Response } from 'express'
import { notFoundError } from '@/errors/not-found-errors'
import { getBillingProvider } from '@/services/billing/billing-provider.service'

/**
 * Pass a request only while Razorpay is the payment provider.
 * @param _request - Unused.
 * @param _response - Unused.
 * @param next - Passes control on, or forwards the 404.
 */
export function requireEnabledBillingWebhook(
  _request: Request,
  _response: Response,
  next: NextFunction
): void {
  if (getBillingProvider()?.kind !== 'razorpay') {
    next(notFoundError('route'))
    return
  }
  next()
}
