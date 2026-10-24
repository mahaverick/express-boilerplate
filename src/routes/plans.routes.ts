/**
 * @file The public plan list, mounted at `/api/v1/plans`, with no
 * authentication: a signed-out pricing page reads it. Its own per-IP limiter
 * bounds it, and the maintenance gate lets it through in every mode, so a
 * pricing page still renders during maintenance.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { billingController } from '@/controllers/billing.controller'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the plans routes.
 * @returns A router mounted at `/api/v1/plans` by `index.routes.ts`.
 */
export function createPlansRouter(): Router {
  const router = Router()
  router.get('/', createRateLimiter(RATE_LIMITS.publicPlans), billingController.getPlans)
  return router
}
