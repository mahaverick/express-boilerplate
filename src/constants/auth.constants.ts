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
 *
 * BEFORE YOU RAISE IT, read this. That last sentence has a consequence for
 * the login timing defence, and this is the place it will actually be seen.
 * `login` (auth.controller.ts) answers an unknown email by verifying
 * against a dummy hash, so both paths pay one real bcrypt comparison and
 * the response time cannot say whether an address is registered. The dummy
 * is hashed at the CURRENT value of this constant; every stored hash
 * verifies at whatever cost it was WRITTEN with. While those agree, the two
 * paths cost the same. Raise this constant and they stop agreeing, in the
 * direction that reopens the channel INVERTED: existing users now verify
 * more cheaply than the dummy, so an unknown email becomes measurably
 * SLOWER than a wrong password for a real account, and the gap widens with
 * every increment (each +1 doubles the work). The endpoint's own comment
 * reasons about a stale hard-coded dummy hash — a different, already-closed
 * problem. This one is about stale STORED hashes, and no amount of care
 * inside the controller can fix it, because there is no single cost that
 * matches every row.
 *
 * The standard remedy is rehash-on-login: after a successful verification,
 * if the stored hash's embedded cost is below this constant, re-hash the
 * submitted password at the new cost and update the row — the one moment
 * the plaintext is legitimately in hand. The population converges on the
 * new cost as users sign in, and the timing gap closes with it. That is NOT
 * built here (nothing in `src/` reads a hash's embedded cost), so raising
 * this constant today means accepting a widening timing oracle on
 * `/login` until every active user has changed their password. Build the
 * rehash first, or raise the cost knowing the trade.
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
 * The longest email address this API stores, in characters — and therefore
 * the longest one `auth.validators.ts` accepts.
 *
 * 320 is the practical maximum for an address (RFC 5321's 64-character
 * local part, an `@`, and a 255-character domain). It lives here, and is
 * imported by BOTH `user.model.ts`'s `varchar('email', ...)` and
 * `emailSchema`, so the validation boundary and the column width are one
 * value rather than two literals that agree today. They must never
 * disagree: a schema that accepts more than the column holds turns a client
 * error into a 500 — Postgres rejects the insert with 22001 (string data
 * right truncation), which is not a unique violation, so
 * `BaseRepository.create` does not translate it and it reaches the terminal
 * error handler as an unexpected failure. A 400-character address did
 * exactly that before this cap existed.
 */
export const MAX_EMAIL_LENGTH = 320

/**
 * The longest first or last name this API stores, in characters.
 *
 * Single-sourced with `users.first_name`/`users.last_name` for the same
 * reason as `MAX_EMAIL_LENGTH` above — both `registerSchema` and
 * `updateProfileSchema` (profile.validators.ts) cap at exactly the column
 * width, so neither can start accepting a value the database will refuse.
 */
export const MAX_NAME_LENGTH = 100

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

/**
 * The strategy name every `passport.use`/`passport.authenticate` call in
 * this codebase refers to for Google Sign-In.
 *
 * Lives here, not in passport.config.ts where it originated, specifically
 * so `auth.controller.ts` can import it too: `handleGoogleCallback`
 * (auth.controller.ts) needs the exact same name `configurePassport()`
 * (passport.config.ts) registered the strategy under, and importing it
 * FROM passport.config.ts would create a real cycle —
 * passport.config.ts already imports `isSecureCookieEnvironment` FROM
 * auth.controller.ts (for its session cookie's `secure` flag), and
 * `import-x/no-cycle` correctly flags the two-file cycle that would result.
 * A shared constants module both can depend on, with neither depending on
 * the other, is what this file exists for generally (see its own header
 * comment) and what resolves this specific case.
 */
export const GOOGLE_STRATEGY_NAME = 'google'
