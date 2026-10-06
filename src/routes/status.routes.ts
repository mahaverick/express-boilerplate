/**
 * @file Public status routes, mounted at `/api/v1/status`, with no
 * authentication. The maintenance gate lets `GET /maintenance` through in
 * every mode, so a client can always learn the mode.
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
  return router
}
