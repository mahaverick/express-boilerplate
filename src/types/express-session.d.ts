/**
 * @file The fields this app keeps in the OAuth round-trip's express-session.
 */
import type { OAuthIntent } from '@/types/oauth-intent'

declare module 'express-session' {
  /**
   * This app's own fields on one Google round-trip's session, from
   * `/auth/google` to the callback (passport keeps the OAuth `state` beside
   * them).
   */
  interface SessionData {
    /**
     * What the round-trip is for, so the callback acts on it and returns there.
     */
    oauthIntent?: OAuthIntent
  }
}
