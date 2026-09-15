// src/constants/auth.constants.ts
//
// Auth-domain magic numbers that need exactly one definition. Kept out of
// global.constants.ts because these are specific to password handling, not
// general-purpose — and because tests/unit/utilities/password.utilities.test.ts
// imports BCRYPT_COST directly, so weakening it here fails that test rather
// than only being noticed by whoever next reads SECURITY.md.

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
