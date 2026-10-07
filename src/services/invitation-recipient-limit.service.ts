/**
 * @file The per-recipient ceiling on invitation mail: at most
 * `INVITATION_RECIPIENT_DAILY_LIMIT` invitation sends (invites and resends)
 * to one address in a fixed 24-hour window, across every tenant and sender.
 * The per-sender limiter bounds one account; this bounds what many accounts
 * can send one inbox. The count lives in Redis under the rate-limit keyspace,
 * under an HMAC of the address, so no address is a Redis key name.
 */
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Whether an invitation send fits the recipient's daily budget.
 */
export type InvitationRecipientBudget = 'spent' | 'exhausted'

/**
 * The Redis key one address's count lives under.
 * @param email - The invited address, in any case.
 * @returns The key.
 */
function recipientKey(email: string): string {
  return redisKey('rl', 'invitation-recipient', hashRateLimitIdentity(email.trim().toLowerCase()))
}

/**
 * Count one invitation send to `email` and say whether it fits the budget.
 * One `MULTI` increments the count and starts its 24-hour expiry on the first
 * send only (`PEXPIRE … NX`), so the window is fixed from that send. A refused
 * send still counts. A Redis failure returns `spent`, logged at `warn`: the
 * ceiling fails open, as the limiters do.
 * @param email - The invited address, in any case.
 * @returns `spent` when the mail may go, `exhausted` when the address has had its share.
 */
export async function spendInvitationRecipientBudget(
  email: string
): Promise<InvitationRecipientBudget> {
  const key = recipientKey(email)
  let count: number
  try {
    const redis = await getRedis()
    const [incremented] = await redis.multi().incr(key).pExpire(key, WINDOW_MS, 'NX').exec()
    count = Number(incremented)
  } catch (error) {
    logger.warn('Invitation recipient budget unavailable; allowing the invitation', { error })
    return 'spent'
  }
  return count <= getEnv().INVITATION_RECIPIENT_DAILY_LIMIT ? 'spent' : 'exhausted'
}
