/**
 * @file The per-recipient ceiling on sign-in link mail: at most
 * `SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT` links to one address in a fixed
 * 24-hour window. The per-IP limiter bounds one client and the mail cooldown
 * one burst; this bounds what many clients can send one inbox in a day. It
 * fails open when Redis does not answer, as the limiters do: a link the
 * owner asked for must still arrive.
 */
import { getEnv } from '@/configs/env.config'
import {
  spendDailyRecipientBudget,
  type RecipientBudget,
} from '@/services/daily-recipient-budget.service'
import { logger } from '@/services/logger.service'

/**
 * Count one sign-in link to `email` and say whether it fits the day's
 * budget. A refused send still counts. A Redis failure returns `spent`,
 * logged at `warn`.
 * @param email - The recipient, in any case.
 * @returns `spent` when the link may go, `exhausted` when the address has had its day's links.
 */
export async function spendSignInLinkBudget(email: string): Promise<RecipientBudget> {
  try {
    return await spendDailyRecipientBudget(
      'sign-in-link-recipient',
      email,
      getEnv().SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT
    )
  } catch (error) {
    logger.warn('Sign-in link recipient budget unavailable; allowing the link', { error })
    return 'spent'
  }
}
