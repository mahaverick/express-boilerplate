/**
 * @file Auth-domain values that need exactly one definition: password
 * hashing limits, field lengths, and the refresh cookie's name, path and
 * domain (`refreshCookieSpec`), so a set, a read and a clear cannot drift.
 */

/**
 * bcrypt work factor (log2 of the number of hashing rounds) applied to
 * every password this boilerplate hashes. Each +1 doubles the time per hash.
 *
 * bcrypt stores the cost in each hash, so raising this affects only
 * passwords hashed afterwards, and a successful `login` (auth.service.ts)
 * rewrites a hash made at a lower cost.
 *
 * Raising it opens a timing gap: `login` answers an unknown email by
 * verifying against a dummy hash made at the current cost, while each stored
 * hash verifies at the cost it was written with. A higher cost makes an
 * unknown email measurably slower than a wrong password for an account whose
 * hash is still at the old cost, which tells whether that email is
 * registered. The gap closes for each account at its next successful login.
 */
export const BCRYPT_COST = 12

/**
 * The longest password bcrypt will actually use, in bytes.
 *
 * bcrypt silently ignores everything past the 72nd byte, so two passwords
 * sharing their first 72 bytes would verify against each other's hash.
 * `password.utilities.ts` rejects longer input at hash and verify time.
 * Counted in UTF-8 bytes, not characters.
 */
export const MAX_PASSWORD_BYTES = 72

/**
 * The shortest password `auth.validators.ts` accepts at registration,
 * password reset and password change.
 *
 * 8 is the NIST SP 800-63B revision 3 minimum for a human-chosen password,
 * with no composition rules, which this boilerplate does not impose. It is
 * this app's chosen floor, not a claim of compliance with the current
 * revision. `loginSchema` does not enforce it, so a too-short password fails
 * login with the same 401 as a wrong one rather than a distinguishable 400.
 */
export const MIN_PASSWORD_LENGTH = 8

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
 * a password reset, a password change or `POST /auth/sessions/revoke-others`
 * from another session, a Google account claim, a staff sign-out,
 * deactivation or deletion, or a sign-in in a browser that presents either
 * chain's cookie.
 *
 * A password change or revoke-others from the same session ends the sibling
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
 *      `requireSessionId` (notification-stream.controller.ts),
 *      `reauthenticate` (auth.service.ts) and `revokeOtherSessions`
 *      (session.service.ts);
 *   4. a user gone or inactive, in `reauthenticate`, `revokeOtherSessions`
 *      and `markSessionReauthenticated` (session.service.ts), the last also
 *      for a session with no live refresh token.
 */
export const ACCESS_TOKEN_EXPIRED_CODE = 'ACCESS_TOKEN_EXPIRED'

/**
 * Machine-readable code for a request refused because its session last
 * authenticated too long ago (`requireRecentAuth`, auth.middleware.ts). The
 * 401 asks the client to confirm the user's identity with `POST
 * /auth/reauthenticate` and retry. It is not a verdict on the session, so a
 * client must not sign out on it.
 */
export const REAUTH_REQUIRED_CODE = 'REAUTH_REQUIRED'

/**
 * How recently a session must have authenticated to pass a step-up route
 * (`requireRecentAuth`): 10 minutes, in milliseconds.
 */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000
