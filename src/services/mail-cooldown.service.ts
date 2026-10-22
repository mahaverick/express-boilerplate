/**
 * @file Cooldowns in Redis. `claimCooldown` holds one slot per scope and key
 * for a window and says how long is left on a held one, for a caller that
 * answers the wait (step-up's 429). `didClaimMailCooldown` is its
 * per-address form for mail: while Redis answers, at most one mail of a kind
 * per address per window, however many requests ask for one. Its callers
 * reply the same whether or not they won the claim, since a 429 would be an
 * enumeration oracle.
 */
import { logger } from '@/services/logger.service'
import { waitForRedisWrite, withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

/**
 * What a claim answers when Redis cannot be reached: `'send'` fails open (the
 * owner must still get the mail), `'skip'` fails closed (the mail is only a
 * notice).
 */
export type MailCooldownFallback = 'send' | 'skip'

/**
 * The key segment for one address: a keyed digest, so no address is a Redis key name.
 * @param email - The address, as submitted.
 * @returns The digest of the trimmed, lowercased address.
 */
export function addressDigest(email: string): string {
  return hashRateLimitIdentity(email.trim().toLowerCase())
}

/**
 * The answer to a cooldown claim: the slot is this caller's, or another
 * claim holds it for `retryAfterMs` more.
 */
export type CooldownClaim = { claimed: true } | { claimed: false; retryAfterMs: number }

/**
 * Try the slot with `SET NX PX` and, when another claim holds it, read the
 * time left with `PTTL`. Only the `SET` rejects: a failed `PTTL` after a held
 * slot answers the whole cooldown, since the slot is known to be held.
 * @param redisKeyName - The full key, already through `redisKey`.
 * @param cooldownMs - How long a won claim holds the slot, rounded up to a whole millisecond.
 * @returns The claim.
 * @throws {Error} Whatever the `SET` or `getRedis()` rejects with, or the deadline's error.
 */
async function trySlot(redisKeyName: string, cooldownMs: number): Promise<CooldownClaim> {
  const px = Math.ceil(cooldownMs)
  const result = await withRedisDeadline(async () => {
    const redis = await getRedis()
    // Redis rejects a non-integer PX.
    return redis.set(redisKeyName, '1', { condition: 'NX', expiration: { type: 'PX', value: px } })
  }, 'cooldown claim')
  if (result === 'OK') return { claimed: true }
  try {
    const left = await withRedisDeadline(async () => {
      const redis = await getRedis()
      return redis.pTTL(redisKeyName)
    }, 'cooldown time left')
    // -2 (expired since the SET) and -1 (no expiry, which no claim writes) still wait a moment.
    return { claimed: false, retryAfterMs: left > 0 ? left : 1 }
  } catch (error) {
    logger.warn('Cooldown time left could not be read; answering the whole cooldown', { error })
    return { claimed: false, retryAfterMs: px }
  }
}

/**
 * Claim a cooldown slot: a Redis `SET NX PX` under `redisKey(scope, key)`,
 * then `PTTL` for the time left when an earlier claim holds it. Never
 * rejects: when Redis cannot be reached it is logged at warn and answered
 * `whenUnavailable`, failing open to claimed by default.
 * @param scope - A fixed key segment naming what the cooldown bounds, such as `'step-up-link'`.
 * @param key - The key segment for one subject: a user id, or `addressDigest` of an address, never a raw address.
 * @param cooldownMs - How long a won claim holds the slot.
 * @param whenUnavailable - `'send'` answers claimed, `'skip'` answers held for the whole cooldown.
 * @returns The claim.
 */
export async function claimCooldown(
  scope: string,
  key: string,
  cooldownMs: number,
  whenUnavailable: MailCooldownFallback = 'send'
): Promise<CooldownClaim> {
  try {
    return await trySlot(redisKey(scope, key), cooldownMs)
  } catch (error) {
    logger.warn('Cooldown could not be read; falling back', {
      error,
      scope,
      fallback: whenUnavailable,
    })
    return whenUnavailable === 'send'
      ? { claimed: true }
      : { claimed: false, retryAfterMs: Math.ceil(cooldownMs) }
  }
}

/**
 * Give back a slot `claimCooldown` won, when the work it guarded failed
 * before anything was sent, so the caller can try again at once. A release
 * always goes out (`waitForRedisWrite`). Never rejects: a failed release is
 * logged at warn, and the slot then lapses on its own.
 * @param scope - The scope the slot was claimed under.
 * @param key - The key it was claimed for.
 * @returns Resolves once the release is answered, or left in flight past the deadline.
 */
export async function releaseCooldown(scope: string, key: string): Promise<void> {
  /**
   * Log a release that failed, before or after the deadline.
   * @param error - What the delete rejected with.
   */
  const reportFailure = (error: unknown): void => {
    logger.warn('Cooldown release failed; the slot lapses on its own', { error, scope })
  }
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.del(redisKey(scope, key))
      },
      'cooldown release',
      reportFailure,
      { scope }
    )
  } catch (error) {
    reportFailure(error)
  }
}

/**
 * Claim the one mail of `scope` that `email` may get in the next
 * `cooldownMs` (`claimCooldown`, keyed on `addressDigest(email)`). True when
 * this call won the slot and the caller may send; false while an earlier
 * claim holds it. Never rejects: a Redis failure is logged at warn and
 * answered by `whenUnavailable`.
 * @param scope - The mail kind, a fixed key segment such as `'sign-in-link'`.
 * @param email - The recipient address.
 * @param cooldownMs - How long a won claim holds the slot, rounded up to a whole millisecond.
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
  const claim = await claimCooldown(
    scope,
    addressDigest(email),
    cooldownMs,
    options.whenUnavailable
  )
  return claim.claimed
}
