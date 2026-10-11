/**
 * @file The fields this app keeps in the OAuth round-trip's express-session.
 */
import type { FrontendApp } from '@/constants/frontend.constants'

declare module 'express-session' {
  /**
   * What is stored for one Google sign-in, from `/auth/google` to its callback.
   */
  interface SessionData {
    /**
     * Which frontend started the Google sign-in, so the callback returns there.
     */
    oauthApp?: FrontendApp
  }
}
