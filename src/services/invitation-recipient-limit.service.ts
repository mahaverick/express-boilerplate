/**
 * @file The per-recipient ceiling on invitation mail: it allows at most
 * `INVITATION_RECIPIENT_DAILY_LIMIT` tenant invitation sends (invites and
 * resends) to one address in a fixed 24-hour window, across every tenant and
 * sender, of which one tenant may spend at most
 * `INVITATION_RECIPIENT_TENANT_SHARE`. The per-sender limiter bounds one
 * account; this bounds what many accounts can send one inbox, and the tenant
 * share stops one tenant from spending an address's whole day so no other
 * tenant can invite it. It fails open when Redis does not answer. The counts
 * live in Redis under the rate-limit keyspace, under an HMAC of the address,
 * so no address is a Redis key name.
 */
import { getEnv } from '@/configs/env.config'
import {
  dailyRecipientKey,
  incrementDailyCount,
  spendDailyRecipientBudget,
  type RecipientBudget,
} from '@/services/daily-recipient-budget.service'
import { logger } from '@/services/logger.service'

/**
 * The key segment the address's count lives under.
 */
const SCOPE = 'invitation-recipient'

/**
 * Most of one address's daily invitation budget a single tenant may spend.
 * Below the default `INVITATION_RECIPIENT_DAILY_LIMIT` of 10, so a tenant
 * re-inviting an address over and over cannot lock every other tenant out of
 * inviting it. A limit configured at or under this value gives one tenant the
 * whole day.
 */
export const INVITATION_RECIPIENT_TENANT_SHARE = 3

/**
 * Count one invitation send to `email` from `tenantId` and say whether it
 * fits the budget. The tenant's share is counted first, under the address's
 * key suffixed with the tenant; a send past it is refused without touching
 * the address's count, so one tenant cannot spend the other tenants' room. A
 * refused send still counts against whichever count refused it, and one the
 * address's ceiling refuses has also spent one of the tenant's share. A
 * Redis failure returns `spent`, logged at `warn`: the ceiling fails open, as
 * the limiters do.
 * @param email - The invited address, in any case.
 * @param tenantId - The tenant the invitation belongs to.
 * @returns `spent` when the mail may go, `exhausted` when the tenant or the address has had its share.
 */
export async function spendInvitationRecipientBudget(
  email: string,
  tenantId: string
): Promise<RecipientBudget> {
  try {
    const tenantCount = await incrementDailyCount(
      `${dailyRecipientKey(SCOPE, email)}:${tenantId}`,
      'invitation recipient budget'
    )
    if (tenantCount > INVITATION_RECIPIENT_TENANT_SHARE) return 'exhausted'
    return await spendDailyRecipientBudget(SCOPE, email, getEnv().INVITATION_RECIPIENT_DAILY_LIMIT)
  } catch (error) {
    logger.warn('Invitation recipient budget unavailable; allowing the invitation', { error })
    return 'spent'
  }
}
