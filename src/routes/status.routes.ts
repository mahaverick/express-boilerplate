/**
 * @file Public status routes, mounted at `/api/v1/status`, with no
 * authentication. The maintenance gate lets `GET /maintenance` and
 * `GET /client-settings` through in every mode, so a client can always learn
 * the mode, and a signed-out page can still state a link's lifetime and the
 * support address.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { statusController } from '@/controllers/status.controller'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the status routes.
 * @returns A router mounted at `/api/v1/status` by `index.routes.ts`.
 */
export function createStatusRouter(): Router {
  const router = Router()
  router.get(
    '/maintenance',
    createRateLimiter(RATE_LIMITS.maintenanceStatus),
    statusController.getMaintenance
  )
  router.get(
    '/client-settings',
    createRateLimiter(RATE_LIMITS.clientSettings),
    statusController.getClientSettings
  )
  return router
}
