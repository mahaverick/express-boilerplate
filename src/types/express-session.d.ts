/**
 * @file The fields this app keeps in the OAuth round-trip's express-session.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

declare module 'express-session' {
  interface SessionData {
    /**
     * Which frontend started the Google sign-in, so the callback returns there.
     */
    oauthApp?: FrontendApp
    /**
     * The session a Google step-up round-trip confirms, stored when it
     * starts (`prepareGoogleStepUp`, auth.controller.ts) and consumed by the
     * callback. Absent on a plain sign-in.
     */
    oauthStepUp?: { userId: string; sessionId: string }
  }
}
