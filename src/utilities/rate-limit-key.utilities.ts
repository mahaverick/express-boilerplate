/**
 * @file `hashRateLimitIdentity`, the digest an address takes wherever it
 * would otherwise be a Redis key name: the email-keyed rate limiters and the
 * per-address mail cooldowns.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { getEnv } from '@/configs/env.config'

/**
 * The HKDF label that separates this key from every other use of SESSION_SECRET.
 */
const IDENTITY_KEY_INFO = 'rate-limit-identity-v1'

/**
 * The derived key, memoised against the secret it came from.
 */
const derived: { secret?: string; key?: Buffer } = {}

/**
 * The HMAC key: HKDF-SHA256 of SESSION_SECRET with the fixed label.
 * @returns The 32-byte key.
 */
function identityKey(): Buffer {
  const secret = getEnv().SESSION_SECRET
  if (derived.key === undefined || derived.secret !== secret) {
    derived.key = Buffer.from(hkdfSync('sha256', secret, '', IDENTITY_KEY_INFO, 32))
    derived.secret = secret
  }
  return derived.key
}

/**
 * A keyed digest of an identity (a normalised address), for a Redis key
 * name: HMAC-SHA256 under a key derived from SESSION_SECRET, hex, first 32
 * characters. Equal inputs share a bucket exactly as the raw value did, but
 * a key name read from Redis names no one, and nobody without the secret can
 * test a guessed address against it. Changing SESSION_SECRET starts every
 * counter afresh.
 * @param value - The identity, already normalised by the caller.
 * @returns 32 lowercase hex characters.
 */
export function hashRateLimitIdentity(value: string): string {
  return createHmac('sha256', identityKey()).update(value).digest('hex').slice(0, 32)
}
