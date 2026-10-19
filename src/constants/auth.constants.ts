/**
 * @file Auth-domain values that need exactly one definition: field
 * lengths, and the refresh cookie's name, path and
 * domain (`refreshCookieSpec`), so a set, a read and a clear cannot drift.
 */

/**
 * The longest email address this API stores, in characters, and therefore
 * the longest one `auth.validators.ts` accepts.
 *
 * 320 is the practical maximum for an address (a 64-character local part,
 * an `@`, and a 255-character domain). The email columns and `emailSchema`
 * share it: a schema that accepted more than a column holds would turn a
 * client error into a 500, since Postgres's 22001 (string data right
 * truncation) is not translated by `BaseRepository.create`.
 */
export const MAX_EMAIL_LENGTH = 320

/**
 * The longest post-sign-in redirect path this API stores, in characters.
 * `user_tokens.redirect` and `redirectPathSchema` share it, for the
 * reason `MAX_EMAIL_LENGTH` gives.
 */
export const MAX_REDIRECT_PATH_LENGTH = 2048

/**
 * The longest first or last name this API stores, in characters.
 *
 * Shared with `users.first_name`/`users.last_name` for the same reason as
 * `MAX_EMAIL_LENGTH`: `registerSchema` and the profile validators cap names
 * at the column width.
 */
export const MAX_NAME_LENGTH = 100

/**
 * The refresh cookie's name without COOKIE_SECURE. With it, the API reads
 * only the prefixed names, because a sibling subdomain or a plain-http
 * attacker can plant a cookie with this one.
 */
const PLAIN_REFRESH_TOKEN_COOKIE_NAME = 'refreshToken'

/**
 * The cookie path for the plain and `__Secure-` forms, so only the auth
 * routes receive the cookie. The `__Host-` form must use `/`, so it goes to
 * every path.
 */
const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth'

/**
 * The name, path and domain a set, a read and a clear of the refresh cookie
 * must all agree on.
 */
export interface RefreshCookieSpec {
  name: string
  path: string
  domain?: string
}

/**
 * The strongest refresh-cookie form the deployment allows. `__Host-` pins
 * the cookie to this exact host over HTTPS but requires `Path=/` and no
 * Domain; `__Secure-` allows a Domain; a plain name needs no HTTPS.
 * @param env - Whether cookies are Secure and the configured COOKIE_DOMAIN.
 * @param env.COOKIE_SECURE - Whether cookies are Secure, resolved through `isCookieSecure`.
 * @param env.COOKIE_DOMAIN - The configured COOKIE_DOMAIN, if any.
 * @returns The cookie's name, path and domain.
 */
export function refreshCookieSpec(env: {
  COOKIE_SECURE: boolean
  COOKIE_DOMAIN?: string | undefined
}): RefreshCookieSpec {
  const domain = env.COOKIE_DOMAIN
  if (!env.COOKIE_SECURE) {
    return domain === undefined
      ? { name: PLAIN_REFRESH_TOKEN_COOKIE_NAME, path: REFRESH_TOKEN_COOKIE_PATH }
      : { name: PLAIN_REFRESH_TOKEN_COOKIE_NAME, path: REFRESH_TOKEN_COOKIE_PATH, domain }
  }
  if (domain === undefined) return { name: '__Host-refreshToken', path: '/' }
  return { name: '__Secure-refreshToken', path: REFRESH_TOKEN_COOKIE_PATH, domain }
}

/**
 * The strategy name for Google Sign-In, shared by `passport.authenticate`
 * (auth.controller.ts, auth.routes.ts) and `passport.use` (passport.config.ts)
 * so the registration and its callers cannot drift.
 */
export const GOOGLE_STRATEGY_NAME = 'google'

/**
 * How long after a refresh token's rotation a replay of it gets a sibling
 * token instead of revoking the session.
 *
 * Accepted trade-off: concurrent tabs stop logging each other out, but a
 * token stolen and replayed within the window also gets a sibling, a second
 * chain that reuse detection never catches. The sibling shares the session,
 * so it lives until SESSION_ABSOLUTE_TTL, until it goes unused for
 * REFRESH_TOKEN_TTL, or until the session ends: a logout from either chain,
 * `POST /auth/sessions/revoke-others` from another session, an account
 * claim, a staff sign-out,
 * deactivation or deletion, or a sign-in in a browser that presents either
 * chain's cookie.
 *
 * A revoke-others from the same session ends the sibling
 * too when the request presents the caller's live refresh cookie, and spares
 * it when it presents no usable one (none, unknown, revoked, or another
 * session's or user's). The sibling's access tokens share the caller's
 * session id, so they last until ACCESS_TOKEN_TTL.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000

/**
 * Machine-readable code for an access token that is not honoured,
 * carried in the error envelope's `code` field. It lets a client tell "try
 * refreshing" from a plain 401 without matching on `message`.
 *
 * Emitted for:
 *   1. an expired token (`verifyBearerToken`, auth.middleware.ts);
 *   2. a denied session (`requireAuth`'s `isSessionDenied` check);
 *   3. a token with no `sid` claim, on the routes that need one:
 *      `requireSessionId` (notification-stream.controller.ts), the step-up
 *      routes (step-up.service.ts) and `revokeOtherSessions`
 *      (session.service.ts);
 *   4. a user gone or inactive, in the step-up routes, `revokeOtherSessions`
 *      and `markSessionReauthenticated` (session.service.ts), the last also
 *      for a session with no live refresh token.
 */
export const ACCESS_TOKEN_EXPIRED_CODE = 'ACCESS_TOKEN_EXPIRED'

/**
 * Machine-readable code for a request refused because its session last
 * authenticated too long ago (`requireRecentAuth`, auth.middleware.ts). The
 * 401 asks the client to confirm the user's identity by step-up (an emailed
 * link, `POST /auth/step-up/link/request`, or a fresh Google login,
 * `POST /auth/step-up/google/start`) and retry. It is not a verdict on the session, so a
 * client must not sign out on it.
 */
export const REAUTH_REQUIRED_CODE = 'REAUTH_REQUIRED'

/**
 * How recently a session must have authenticated to pass a step-up route
 * (`requireRecentAuth`): 10 minutes, in milliseconds.
 */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000

/**
 * Machine-readable code for a sign-in link that cannot sign anyone in:
 * unknown, already used, revoked, expired, malformed, or for an account that
 * is inactive or (on Apex) not staff. One code and one message for every
 * case, so the answer tells nothing about which. The status is 400, never
 * 401: the clients sign out on a 401.
 */
export const LINK_INVALID_CODE = 'LINK_INVALID'

/**
 * The message `LINK_INVALID_CODE` is answered with.
 */
export const LINK_INVALID_MESSAGE = 'This link has expired or was already used.'
