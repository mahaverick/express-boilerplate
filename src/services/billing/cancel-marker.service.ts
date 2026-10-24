/**
 * @file The cancel marker: before an owner's or a staff cancel calls the
 * provider, it records on the billing row who is cancelling which
 * subscription, so a sync that brings the cancel in first (the provider's
 * webhook) still reads it as theirs, in the mail and in analytics alike
 * (`cancelMarkerOf`, `src/utilities/billing-rules.utilities.ts`). It is
 * written whether or not analytics is on, and lives in the database, so a
 * Redis outage can't change a mail's cause.
 */
import { BillingRepository } from '@/repositories/billing.repository'
import { UserRepository } from '@/repositories/user.repository'
import { withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'

const billingRepository = new BillingRepository()
const userRepository = new UserRepository()

/**
 * Record who is cancelling a subscription, before the provider is asked. An
 * owner's user row is locked `FOR KEY SHARE` first, in the documented lock
 * order, so the marker's foreign-key check never locks it after the
 * billing row.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription being cancelled.
 * @param marker - Who is cancelling.
 * @throws {Error} When the marker can't be written; the cancel is not sent then.
 */
export async function markCancel(
  tenantId: string,
  subscriptionId: string,
  marker: { by: 'owner'; userId: string } | { by: 'staff' }
): Promise<void> {
  const userId = marker.by === 'owner' ? marker.userId : null
  await withTransaction(async (tx) => {
    // The user row before the billing row, as the lock order has it: the marker's foreign key would otherwise lock the user after the billing row.
    if (userId !== null) await userRepository.lockById(userId, 'key share', tx)
    await billingRepository.setCancelMarker(
      tenantId,
      { subscriptionId, by: marker.by, userId, at: new Date() },
      tx
    )
  })
}

/**
 * Forget a cancel marker when the cancel did not happen. Best effort: a
 * failure is logged, and the marker stops counting after its window.
 * @param tenantId - The workspace.
 * @param subscriptionId - The subscription.
 */
export async function clearCancelMarker(tenantId: string, subscriptionId: string): Promise<void> {
  try {
    await billingRepository.clearCancelMarker(tenantId, subscriptionId)
  } catch (error) {
    logger.warn('Could not clear a cancel marker', { error, tenantId, subscriptionId })
  }
}
