/**
 * @file The one module that imports bcrypt, so the work factor and the
 * 72-byte guard live in one place.
 */
import * as bcrypt from 'bcrypt'
import { BCRYPT_COST, MAX_PASSWORD_BYTES } from '@/constants/auth.constants'
import { logger } from '@/services/logger.service'

/**
 * Hash a plaintext password with bcrypt at `BCRYPT_COST`.
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
 * Never throws. A hash that makes bcrypt throw (a null or non-string value
 * past the type) is a failed match, not a 500, so a caller cannot tell a
 * corrupt row from a wrong password; the operator gets an error log line,
 * which carries neither the password nor the hash.
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
    logger.error('isPasswordValid: comparison threw, treating as no match', { error })
    return false
  }
}

/**
 * A bcrypt hash of a fixed, non-secret plaintext, so `login` (auth.service.ts)
 * pays a real compare for an unknown email. Hashed lazily through
 * `hashPassword` and memoised, so it always costs the current `BCRYPT_COST`.
 * A stored hash keeps the cost it was written with, so raising the cost
 * makes an unknown email slower than a wrong password until rows are
 * rehashed; see `BCRYPT_COST` (auth.constants.ts).
 * @returns A memoised promise of a bcrypt hash of a fixed, non-secret plaintext.
 */
export const getDummyHash: () => Promise<string> = (() => {
  let cached: Promise<string> | undefined
  return (): Promise<string> => {
    cached ??= hashPassword('not-a-real-password-used-only-to-pay-bcrypts-cost')
    return cached
  }
})()
