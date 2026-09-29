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
  }
}
