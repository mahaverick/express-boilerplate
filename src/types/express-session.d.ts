/**
 * @file The fields this app keeps in the OAuth round-trip's express-session.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

declare module 'express-session' {
  /**
   * This app's own fields on one Google sign-in's session, from `/auth/google`
   * to its callback (passport keeps the OAuth `state` beside them).
   */
  interface SessionData {
    /**
     * Which frontend started the Google sign-in, so the callback returns there.
     */
    oauthApp?: FrontendApp
  }
}
