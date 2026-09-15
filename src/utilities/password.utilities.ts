// src/utilities/password.utilities.ts
//
// The one module that imports bcrypt. Callers hash and verify through
// hashPassword()/isPasswordValid() rather than reaching for bcrypt directly,
// so the work factor and the 72-byte truncation guard (auth.constants.ts)
// live in exactly one place instead of being re-decided at every call site.
import * as bcrypt from 'bcrypt'
import { BCRYPT_COST, MAX_PASSWORD_BYTES } from '@/constants/auth.constants'

/**
 * Hash a plaintext password with bcrypt at `BCRYPT_COST`.
 *
 * bcrypt generates a fresh random salt internally on every call, so hashing
 * the same password twice produces two different hash strings — this
 * function never accepts or reuses a caller-supplied salt.
 *
 * Rejects a password longer than `MAX_PASSWORD_BYTES` instead of silently
 * hashing only its first 72 bytes: bcrypt ignores anything past that point,
 * so without this check two different passwords sharing that prefix would
 * hash identically. The error message deliberately does not state the
 * limit, so a client can't use it to fingerprint accounts or probe exactly
 * where the truncation boundary sits.
 * @param plain - The password to hash, as typed by the user.
 * @returns The bcrypt hash string, safe to store.
 */
export async function hashPassword(plain: string): Promise<string> {
  if (Buffer.byteLength(plain, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error('Password exceeds the maximum supported length.')
  }

  return bcrypt.hash(plain, BCRYPT_COST)
}

/**
 * Whether a plaintext password matches a stored bcrypt hash.
 *
 * Never throws. A hash that is missing, empty, or otherwise not a valid
 * bcrypt hash — a corrupt row, a column that was never populated — is
 * treated as a failed match rather than surfaced as a 500: a broken login
 * is a better failure mode than a broken row taking down the endpoint, and
 * an attacker sees the same outcome either way, with nothing to tell
 * "this hash is corrupt" apart from "this password is wrong". That last
 * property is exactly why this function does not distinguish the two
 * cases in its return value — only in the log, at error level, precisely
 * because a corrupt hash is silent and permanent data corruption that an
 * operator should be told about even though the caller cannot see it. No
 * password or hash value is written to that log line.
 *
 * A password longer than `MAX_PASSWORD_BYTES` is also rejected outright
 * (returned as no match, not thrown) rather than passed to bcrypt, which
 * would otherwise compare only its first 72 bytes and could match a hash
 * created from a different password that happens to share that prefix.
 * @param plain - The password supplied at login.
 * @param hash - The stored bcrypt hash to compare against.
 * @returns Whether `plain` matches `hash`.
 */
export async function isPasswordValid(plain: string, hash: string): Promise<boolean> {
  if (Buffer.byteLength(plain, 'utf8') > MAX_PASSWORD_BYTES) {
    return false
  }

  try {
    return await bcrypt.compare(plain, hash)
  } catch (error) {
    // Reachable today mainly for a null/undefined/non-string hash reaching
    // this function past its type — e.g. a nullable password_hash column
    // read without a null check — since bcrypt's own native binding
    // already resolves `false` rather than throwing for a merely
    // malformed-but-string hash (verified empirically against the
    // installed bcrypt version). The catch stays regardless: it is what
    // keeps this function's "never throws" contract true even if that
    // binding detail changes.
    console.error(
      '[password.utilities] isPasswordValid: comparison threw, treating as no match',
      error
    )
    return false
  }
}
