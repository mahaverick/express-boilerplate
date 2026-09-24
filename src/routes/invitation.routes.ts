// src/routes/invitation.routes.ts
//
// The invitee's side of an invitation, mounted at `/api/v1/invitations` by
// index.routes.ts. Both take the token in a JSON body, never in the URL.
// Preview is public: a token holder sees what they were invited to before
// signing in. Accept needs a signed-in user. Each limiter runs before any
// database read.
import { Router } from 'express'
import { acceptInvitation, previewInvitation } from '@/controllers/invitation.controller'
import { requireAuth } from '@/middlewares/auth.middleware'
import { requireJsonContentType } from '@/middlewares/content-type.middleware'
import {
  createInvitationAcceptRateLimiter,
  createInvitationPreviewRateLimiter,
} from '@/middlewares/rate-limit.middleware'

/**
 * Build the invitation routes.
 * @returns A router mounted at `/api/v1/invitations` by `index.routes.ts`.
 */
export function createInvitationRouter(): Router {
  const router = Router()
  router.post(
    '/preview',
    requireJsonContentType,
    createInvitationPreviewRateLimiter(),
    previewInvitation
  )
  router.post(
    '/accept',
    requireJsonContentType,
    createInvitationAcceptRateLimiter(),
    requireAuth,
    acceptInvitation
  )
  return router
}
