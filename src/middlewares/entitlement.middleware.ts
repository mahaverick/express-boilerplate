/**
 * @file `requireFeature`, the route gate for a plan feature. Unlike a flag
 * gate it does not hide the route: a refused workspace gets 402
 * `PLAN_FEATURE_REQUIRED` with the feature's key in `details`, so a client
 * can offer the upgrade. Also `requirePaymentsEnabled`, which hides the
 * routes that need a payment provider while none is configured.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { PLAN_FEATURE_REQUIRED_CODE } from '@/constants/billing.constants'
import { ENTITLEMENTS, type FeatureKey } from '@/constants/entitlements.constants'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { logger } from '@/services/logger.service'

/**
 * Admit the request only when the workspace's plan, or a grant, includes the
 * feature. Mount it after `resolveTenant()`; the platform tenant always
 * passes. A request with no `request.principal` is a wiring mistake: it
 * answers the unknown-route 404 and logs `feature_gate_no_tenant` at `error`.
 * @param key - The feature the route needs.
 * @returns An Express middleware.
 */
export function requireFeature(key: FeatureKey): RequestHandler {
  /**
   * Answer 402 unless the workspace has the feature; `requireFeature`'s handler.
   * @param request - The request, after `resolveTenant()`.
   * @param _response - Unused.
   * @param next - Continues the chain, or receives the refusal or a failure.
   */
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = request.principal
      if (principal === undefined) {
        logger.error('feature_gate_no_tenant', { feature: key })
        next(notFoundError('route'))
        return
      }
      if (principal.isPlatformTenant) {
        next()
        return
      }
      const { features } = await getEffectiveEntitlements(principal.tenantId)
      if (features[key] === true) {
        next()
        return
      }
      next(
        new HttpError(
          `${ENTITLEMENTS[key].label} is included in Paid. Upgrade to use it.`,
          402,
          PLAN_FEATURE_REQUIRED_CODE,
          undefined,
          { details: { key } }
        )
      )
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Answer the unknown-route 404 while no payment provider is configured, so
 * the billing writes and the invoice list look absent. Mount it first on such
 * a route, ahead of the JSON gate and the limiter, as an unknown path answers
 * before either.
 * @param _request - Unused.
 * @param _response - Unused.
 * @param next - Continues the chain, or receives the 404.
 */
export function requirePaymentsEnabled(
  _request: Request,
  _response: Response,
  next: NextFunction
): void {
  next(getBillingProvider() === null ? notFoundError('route') : undefined)
}
