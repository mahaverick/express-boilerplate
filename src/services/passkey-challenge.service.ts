/**
 * @file Single-use passkey challenges in Redis. A challenge is bound to the
 * purpose it was issued for and to a user or session, lives for
 * `PASSKEY_CHALLENGE_TTL_MS`, and is deleted by the first read, so a replayed,
 * cross-purpose or cross-user challenge answers `undefined`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { PASSKEY_CHALLENGE_TTL_MS, type PasskeyPurpose } from '@/constants/passkey.constants'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'

/**
 * Who a challenge belongs to: a user, a session, both, or neither (sign-in).
 */
export interface PasskeyChallengeBinding {
  userId?: string | undefined
  sessionId?: string | undefined
}

/**
 * What is stored under a challenge's key.
 */
interface StoredChallenge extends PasskeyChallengeBinding {
  purpose: PasskeyPurpose
  challenge: string
}

/**
 * Whether a parsed value has the shape `issuePasskeyChallenge` stores.
 * @param value - The parsed JSON.
 * @returns True for an object with a string purpose and challenge.
 */
function isStoredChallenge(value: unknown): value is StoredChallenge {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.purpose === 'string' && typeof record.challenge === 'string'
}

/**
 * Issue a challenge: 32 random bytes as base64url, stored in Redis under a
 * fresh UUID for the TTL.
 * @param purpose - What the challenge is for.
 * @param binding - The user or session that may consume it.
 * @param options - Test seam.
 * @param options.ttlMs - The lifetime in ms (default `PASSKEY_CHALLENGE_TTL_MS`).
 * @returns The challenge id for the client to send back, and the challenge itself.
 * @throws {Error} When Redis cannot be reached in time.
 */
export async function issuePasskeyChallenge(
  purpose: PasskeyPurpose,
  binding: PasskeyChallengeBinding,
  options: { ttlMs?: number } = {}
): Promise<{ challengeId: string; challenge: string }> {
  const { ttlMs = PASSKEY_CHALLENGE_TTL_MS } = options
  const challengeId = randomUUID()
  const challenge = randomBytes(32).toString('base64url')
  const stored: StoredChallenge = {
    purpose,
    challenge,
    userId: binding.userId,
    sessionId: binding.sessionId,
  }
  await withRedisDeadline(async () => {
    const redis = await getRedis()
    return redis.set(redisKey('passkey-challenge', challengeId), JSON.stringify(stored), {
      PX: Math.ceil(ttlMs),
    })
  }, 'passkey challenge issue')
  return { challengeId, challenge }
}

/**
 * Consume a challenge with `GETDEL`, so the key is gone after this read
 * whether or not the purpose and binding match.
 * @param challengeId - The id `issuePasskeyChallenge` answered.
 * @param purpose - What the caller is using the challenge for.
 * @param binding - The user or session the caller acts for.
 * @returns The challenge, or `undefined` when it is missing, expired, already used, or its purpose or binding differs.
 * @throws {Error} When Redis cannot be reached in time.
 */
export async function consumePasskeyChallenge(
  challengeId: string,
  purpose: PasskeyPurpose,
  binding: PasskeyChallengeBinding
): Promise<string | undefined> {
  const raw = await withRedisDeadline(async () => {
    const redis = await getRedis()
    return redis.getDel(redisKey('passkey-challenge', challengeId))
  }, 'passkey challenge consume')
  if (raw === null) return undefined
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isStoredChallenge(stored)) return undefined
  if (stored.purpose !== purpose) return undefined
  if (stored.userId !== binding.userId) return undefined
  if (stored.sessionId !== binding.sessionId) return undefined
  return stored.challenge
}
