/**
 * @file The per-recipient ceiling on invitation mail: at most
 * `INVITATION_RECIPIENT_DAILY_LIMIT` tenant invitation sends (invites and
 * resends) to one address in a fixed 24-hour window, across every tenant and
 * sender, of which one tenant may spend at most
 * `INVITATION_RECIPIENT_TENANT_SHARE`. The per-sender limiter bounds one
 * account; this bounds what many accounts can send one inbox, and the tenant
 * share stops one tenant from spending an address's whole day so no other
 * tenant can invite it. The counts live in Redis under the rate-limit
 * keyspace, under an HMAC of the address, so no address is a Redis key name.
 */
import { getEnv } from '@/configs/env.config'
import { logger } from '@/services/logger.service'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Most of one address's daily invitation budget a single tenant may spend.
 * Below `INVITATION_RECIPIENT_DAILY_LIMIT`, so a tenant re-inviting an
 * address over and over cannot lock every other tenant out of inviting it.
 */
export const INVITATION_RECIPIENT_TENANT_SHARE = 3

/**
 * Whether an invitation send fits the recipient's daily budget.
 */
export type InvitationRecipientBudget = 'spent' | 'exhausted'

type RedisClient = Awaited<ReturnType<typeof getRedis>>

/**
 * The Redis key one address's count across every tenant lives under.
 * @param email - The invited address, in any case.
 * @returns The key.
 */
function recipientKey(email: string): string {
  return redisKey('rl', 'invitation-recipient', hashRateLimitIdentity(email.trim().toLowerCase()))
}

/**
 * Increment a count whose fixed 24-hour window starts at its first
 * increment: one `MULTI` runs `INCR` and `PEXPIRE … NX`.
 * @param redis - The client.
 * @param key - The count's key.
 * @returns The count after this increment.
 */
async function incrementInWindow(redis: RedisClient, key: string): Promise<number> {
  const [incremented] = await redis.multi().incr(key).pExpire(key, WINDOW_MS, 'NX').exec()
  return Number(incremented)
}

/**
 * Count one invitation send to `email` from `tenantId` and say whether it
 * fits the budget. The tenant's share is counted first; a send past it is
 * refused without touching the address's count, so one tenant cannot spend
 * the other tenants' room. A refused send still counts against whichever
 * count refused it, and one the address's global ceiling refuses has also spent one
 * of the tenant's share. A Redis failure returns `spent`, logged at `warn`: the
 * ceiling fails open, as the limiters do.
 * @param email - The invited address, in any case.
 * @param tenantId - The tenant the invitation belongs to.
 * @returns `spent` when the mail may go, `exhausted` when the tenant or the address has had its share.
 */
export async function spendInvitationRecipientBudget(
  email: string,
  tenantId: string
): Promise<InvitationRecipientBudget> {
  const key = recipientKey(email)
  try {
    const redis = await getRedis()
    const tenantCount = await withRedisDeadline(
      () => incrementInWindow(redis, `${key}:${tenantId}`),
      'invitation recipient budget'
    )
    if (tenantCount > INVITATION_RECIPIENT_TENANT_SHARE) return 'exhausted'
    const count = await withRedisDeadline(
      () => incrementInWindow(redis, key),
      'invitation recipient budget'
    )
    return count <= getEnv().INVITATION_RECIPIENT_DAILY_LIMIT ? 'spent' : 'exhausted'
  } catch (error) {
    logger.warn('Invitation recipient budget unavailable; allowing the invitation', { error })
    return 'spent'
  }
}
