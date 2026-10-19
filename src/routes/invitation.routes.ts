/**
 * @file The invitee's side of an invitation, mounted at `/api/v1/invitations`.
 * Every route takes the token in a JSON body, never in the URL. Preview is
 * public, so a token holder sees the invitation before signing in; verify
 * and confirm are public too and sign the invitee in, so they set the
 * refresh cookie behind the Origin check, and share one limiter; accept
 * needs a signed-in user. Each limiter runs before the invitation is read.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { invitationController } from '@/controllers/invitation.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import { requireAllowedOriginWhenPresent } from '@/middlewares/origin.middleware'
import { createRateLimiter } from '@/middlewares/rate-limit.middleware'

/**
 * Build the invitation routes.
 * @returns A router mounted at `/api/v1/invitations` by `index.routes.ts`.
 */
export function createInvitationRouter(): Router {
  const router = Router()
  router.post(
    '/preview',
    requireJsonContentType,
    createRateLimiter(RATE_LIMITS.invitationPreview),
    invitationController.previewInvitation
  )
  // One instance on both, so a confirm spends the same budget as the click that mailed it.
  const invitationVerifyLimiter = createRateLimiter(RATE_LIMITS.invitationVerify)
  // A sign-in sets the refresh cookie: the Origin check runs before the limiter, as on /auth/link/verify, so a refused page spends no budget.
  router.post(
    '/verify',
    requireJsonContentType,
    requireAllowedOriginWhenPresent,
    invitationVerifyLimiter,
    invitationController.verifyInvitation
  )
  router.post(
    '/confirm',
    requireJsonContentType,
    requireAllowedOriginWhenPresent,
    invitationVerifyLimiter,
    invitationController.confirmInvitation
  )
  // requireAuth first: anonymous traffic from a shared IP never spends a signed-in invitee's budget, and the limiter keys on request.user.id.
  router.post(
    '/accept',
    requireAuth,
    requireJsonContentType,
    createRateLimiter(RATE_LIMITS.invitationAccept),
    invitationController.acceptInvitation
  )
  return router
}
