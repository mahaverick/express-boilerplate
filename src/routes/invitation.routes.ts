/**
 * @file The invitee's side of an invitation, mounted at `/api/v1/invitations`.
 * Both routes take the token in a JSON body, never in the URL. Preview is
 * public, so a token holder sees the invitation before signing in; accept
 * needs a signed-in user. Each limiter runs before the invitation is read.
 */
import { Router } from 'express'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import { invitationController } from '@/controllers/invitation.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
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
