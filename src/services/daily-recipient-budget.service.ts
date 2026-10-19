/**
 * @file A per-address count of mail in a fixed 24-hour window that starts at
 * the first send, the shared core of the per-recipient mail ceilings
 * (invitation-recipient-limit.service.ts, sign-in-link-limit.service.ts).
 * The counts live in Redis under the rate-limit keyspace, under an HMAC of
 * the address, so no address is a Redis key name. Each caller decides what a
 * Redis failure means, since only it can name what it lets through.
 */
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The verdict on one send: `spent` when it fits the budget, `exhausted` when
 * the budget is used up.
 */
export type RecipientBudget = 'spent' | 'exhausted'

/**
 * The Redis key one address's count of one kind of mail lives under.
 * @param scope - The mail kind, a fixed key segment such as `'invitation-recipient'`.
 * @param email - The address, in any case.
 * @returns The key.
 */
export function dailyRecipientKey(scope: string, email: string): string {
  return redisKey('rl', scope, hashRateLimitIdentity(email.trim().toLowerCase()))
}

/**
 * Increment a count whose fixed 24-hour window starts at its first
 * increment: one `MULTI` runs `INCR` and `PEXPIRE … NX`, within the request
 * deadline.
 * @param key - The count's key.
 * @param label - What the deadline names when Redis does not answer.
 * @returns The count after this increment.
 * @throws {Error} When Redis fails or does not answer within the deadline.
 */
export async function incrementDailyCount(key: string, label: string): Promise<number> {
  return withRedisDeadline(async () => {
    const redis = await getRedis()
    const [incremented] = await redis.multi().incr(key).pExpire(key, WINDOW_MS, 'NX').exec()
    return Number(incremented)
  }, label)
}

/**
 * Count one send of `scope` mail to `email` and say whether it fits `limit`
 * a day. A refused send still counts, so a caller over the limit stays over
 * it until the window ends.
 * @param scope - The mail kind, a fixed key segment.
 * @param email - The recipient, in any case.
 * @param limit - The most sends a day.
 * @returns `spent` when the mail may go, `exhausted` past the limit.
 * @throws {Error} When Redis fails or does not answer; the caller decides whether that fails open.
 */
export async function spendDailyRecipientBudget(
  scope: string,
  email: string,
  limit: number
): Promise<RecipientBudget> {
  const count = await incrementDailyCount(dailyRecipientKey(scope, email), `${scope} budget`)
  return count <= limit ? 'spent' : 'exhausted'
}
