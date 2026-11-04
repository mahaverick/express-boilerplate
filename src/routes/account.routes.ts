/**
 * @file The `/api/v1/account` routes: a customer's request to delete their
 * account. The request needs a recent sign-in; reading it back does not.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { accountController } from '@/controllers/account.controller'
import { requireAuth, requireRecentAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the account routes.
 * @returns A router mounted at `/api/v1/account` by `index.routes.ts`.
 */
export function createAccountRouter(): Router {
  const router = Router()
  // Built once per router; requireAuth runs first, as both key on request.user.id.
  const writeLimiter = createRateLimiter(RATE_LIMITS.authenticatedWrite)
  const readLimiter = createRateLimiter(RATE_LIMITS.accountDeletionRead)
  router.post(
    '/deletion-request',
    requireAuth,
    requireJsonContentType,
    requireRecentAuth(),
    writeLimiter,
    accountController.requestDeletion
  )
  router.get('/deletion-request', requireAuth, readLimiter, accountController.getDeletionRequest)
  return router
}
