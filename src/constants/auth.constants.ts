// src/constants/auth.constants.ts
//
// Auth-domain values that need exactly one definition. Kept out of
// global.constants.ts because these are specific to password/session
// handling, not general-purpose — and because
// tests/unit/utilities/password.utilities.test.ts imports BCRYPT_COST
// directly, so weakening it here fails that test rather than only being
// noticed by whoever next reads SECURITY.md.
//
// The two cookie constants below exist here — not as literals inside
// auth.controller.ts — because Task 7 (refresh/logout) reads and clears the
// same cookie by name and path. A literal string repeated in a second file
// is exactly the kind of drift this file exists to prevent everywhere else.

/**
 * bcrypt work factor (log2 of the number of hashing rounds) applied to
 * every password this boilerplate hashes.
 *
 * 12 is OWASP's floor recommendation as of this writing and costs roughly
 * 200-300ms per hash on typical current server hardware — expensive enough
 * to make offline brute-forcing costly, cheap enough that a login stays
 * imperceptibly fast for a real user. Hardware gets faster every year, so
 * this is a value to revisit periodically (OWASP's guidance is "as high as
 * your slowest acceptable login lets you go"), not a constant to set once
 * and forget. Raising it only affects passwords hashed after the change —
 * bcrypt encodes its own cost in the hash string, so existing rows keep
 * verifying at whatever cost they were created with.
 */
export const BCRYPT_COST = 12

/**
 * The longest password bcrypt will actually use, in bytes.
 *
 * bcrypt silently ignores everything past the 72nd byte of its input
 * instead of erroring — so two different passwords that happen to share
 * the same first 72 bytes hash identically, and either one then verifies
 * successfully against the other's hash. `password.utilities.ts` rejects
 * input longer than this at both hash time and verify time so that
 * collision can't occur, rather than silently accepting a password whose
 * tail is never actually checked. Measured in UTF-8 bytes, not characters:
 * a single multi-byte character can already use most of this budget.
 */
export const MAX_PASSWORD_BYTES = 72

/**
 * The shortest password `auth.validators.ts` accepts at registration.
 *
 * 8 is the floor both OWASP's and NIST's (SP 800-63B) current guidance
 * converge on for a human-chosen password with no other composition rules
 * forced on it — this boilerplate does not require a mix of character
 * classes, which modern guidance treats as pushing users toward
 * predictable substitutions rather than genuinely harder-to-guess
 * passwords. Only registration enforces this: `loginSchema` deliberately
 * does not, so a wrong password can never fail validation differently
 * than an unknown email (see auth.validators.ts's header comment).
 */
export const MIN_PASSWORD_LENGTH = 8

/**
 * Name of the httpOnly cookie the refresh token travels in.
 */
export const REFRESH_TOKEN_COOKIE_NAME = 'refreshToken'

/**
 * The only path the refresh-token cookie is sent to. Scoping it to the
 * auth routes — rather than the whole API — means a request to any other
 * endpoint never carries this cookie at all, which is one less place a
 * stolen-cookie attack surface has to be reasoned about.
 */
export const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth'
