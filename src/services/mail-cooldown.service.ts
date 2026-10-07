/**
 * @file `didClaimMailCooldown`, a per-address mail cooldown in Redis: at most
 * one mail of a kind per address per window, however many requests ask for
 * one, with no reply that differs (a 429 would be an enumeration oracle).
 */
import { createHash } from 'node:crypto'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'

/**
 * What a claim answers when Redis cannot be reached: `'send'` fails open (the
 * owner must still get the mail), `'skip'` fails closed (the mail is only a
 * notice).
 */
export type MailCooldownFallback = 'send' | 'skip'

/**
 * The key segment for one address: a digest, so no address is a Redis key name.
 * @param email - The address, as submitted.
 * @returns The digest of the trimmed, lowercased address.
 */
function addressDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/**
 * Claim the one mail of `scope` that `email` may get in the next
 * `cooldownMs`: a Redis `SET NX PX` under `redisKey(scope, digest)`. True
 * when this call won the slot and the caller may send; false while an
 * earlier claim holds it. Never rejects: a Redis failure is logged at warn
 * and answered by `whenUnavailable`.
 * @param scope - The mail kind, a fixed key segment such as `'password-reset-notice'`.
 * @param email - The recipient address.
 * @param cooldownMs - How long a won claim holds the slot.
 * @param options - What to answer when Redis cannot be reached.
 * @param options.whenUnavailable - `'send'` answers true, `'skip'` answers false.
 * @returns Whether the caller may send the mail now.
 */
export async function didClaimMailCooldown(
  scope: string,
  email: string,
  cooldownMs: number,
  options: { whenUnavailable: MailCooldownFallback }
): Promise<boolean> {
  try {
    const client = await getRedis()
    const result = await client.set(redisKey(scope, addressDigest(email)), '1', {
      NX: true,
      PX: cooldownMs,
    })
    return result === 'OK'
  } catch (error) {
    logger.warn('Mail cooldown could not be read; falling back', {
      error,
      scope,
      fallback: options.whenUnavailable,
    })
    return options.whenUnavailable === 'send'
  }
}
