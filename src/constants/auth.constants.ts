/**
 * @file Auth-domain values that need exactly one definition: password
 * hashing limits, field lengths, and the refresh cookie's name, path and
 * domain (`refreshCookieSpec`), so a set, a read and a clear cannot drift.
 */

/**
 * bcrypt work factor (log2 of the number of hashing rounds) applied to
 * every password this boilerplate hashes.
 *
 * 12 is OWASP's floor recommendation, roughly 200-300ms per hash on typical
 * server hardware. bcrypt stores the cost in each hash, so raising this
 * affects only passwords hashed afterwards.
 *
 * Before raising it: `login` (auth.service.ts) answers an unknown email by
 * verifying against a dummy hash made at this cost, while each stored hash
 * verifies at the cost it was written with. A higher cost makes an unknown
 * email measurably slower than a wrong password for an existing account,
 * reopening the login timing oracle (whether an email is registered), and
 * each +1 doubles the gap.
 * Nothing here rehashes on login, so the gap lasts until every active user
 * has a new hash. Build rehash-on-login first, or accept that trade.
 */
export const BCRYPT_COST = 12

/**
 * The longest password bcrypt will actually use, in bytes.
 *
 * bcrypt silently ignores everything past the 72nd byte, so two passwords
 * sharing their first 72 bytes would verify against each other's hash.
 * `password.utilities.ts` rejects longer input at hash and verify time.
 * Measured in UTF-8 bytes, not characters.
 */
export const MAX_PASSWORD_BYTES = 72

/**
 * The shortest password `auth.validators.ts` accepts at registration,
 * password reset and password change.
 *
 * 8 is the OWASP and NIST SP 800-63B floor for a human-chosen password with
 * no composition rules, which this boilerplate does not impose. Registration,
 * password reset and password change enforce it; `loginSchema` does not, so
 * a wrong password never fails validation differently than an unknown email.
 */
export const MIN_PASSWORD_LENGTH = 8

/**
 * The longest email address this API stores, in characters — and therefore
 * the longest one `auth.validators.ts` accepts.
 *
 * 320 is the practical maximum for an address (RFC 5321's 64-character
 * local part, an `@`, and a 255-character domain). Both `user.model.ts`'s
 * `email` column and `emailSchema` import it: a schema that accepted more
 * than the column holds would turn a client error into a 500, since
 * Postgres's 22001 (string data right truncation) is not translated by
 * `BaseRepository.create`.
 */
export const MAX_EMAIL_LENGTH = 320

/**
 * The longest first or last name this API stores, in characters.
 *
 * Shared with `users.first_name`/`users.last_name` for the same reason as
 * `MAX_EMAIL_LENGTH`: `registerSchema` and `updateProfileSchema` cap at the
 * column width.
 */
export const MAX_NAME_LENGTH = 100

/**
 * The refresh cookie's unprefixed name: the current name without
 * COOKIE_SECURE, and also read with it so a browser holding it keeps its
 * session.
 * @deprecated removed in the next major version
 */
export const LEGACY_REFRESH_TOKEN_COOKIE_NAME = 'refreshToken'

/**
 * The auth routes, so no other endpoint receives the cookie. `__Host-`
 * forbids any path but `/`.
 */
const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth'

/**
 * Where the refresh cookie lives: the name, path and domain a set, a read
 * and a clear must all agree on.
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
      ? // eslint-disable-next-line sonarjs/deprecation -- builds the unprefixed cookie's spec until the next major
        { name: LEGACY_REFRESH_TOKEN_COOKIE_NAME, path: REFRESH_TOKEN_COOKIE_PATH }
      : // eslint-disable-next-line sonarjs/deprecation -- builds the unprefixed cookie's spec until the next major
        { name: LEGACY_REFRESH_TOKEN_COOKIE_NAME, path: REFRESH_TOKEN_COOKIE_PATH, domain }
  }
  if (domain === undefined) return { name: '__Host-refreshToken', path: '/' }
  return { name: '__Secure-refreshToken', path: REFRESH_TOKEN_COOKIE_PATH, domain }
}

/**
 * The strategy name every `passport.use`/`passport.authenticate` call uses
 * for Google Sign-In, shared by `handleGoogleCallback` (auth.controller.ts)
 * and `configurePassport()` (passport.config.ts) without either importing
 * the other.
 */
export const GOOGLE_STRATEGY_NAME = 'google'

/**
 * How long after a refresh token's rotation a replay of it gets a sibling token instead of revoking the session.
 *
 * Accepted trade-off: concurrent tabs stop logging each other out; a token stolen and replayed within the window also gets a sibling.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000

/**
 * Machine-readable code identifying an expired (not merely invalid) access
 * token, carried in the error envelope's `code` field — lets a client
 * distinguish "try refreshing" from "log in again" without matching on
 * `message`.
 *
 * Three emitters, all meaning "no longer honoured, refresh":
 *   1. an expired token — `verifyBearerToken` (auth.middleware.ts);
 *   2. a denied session — `requireAuth`'s `isSessionDenied` check;
 *   3. a token with no `sid` claim — `requireSessionId`
 *      (notification-stream.controller.ts), the only place that refuses one.
 */
export const ACCESS_TOKEN_EXPIRED_CODE = 'ACCESS_TOKEN_EXPIRED'
