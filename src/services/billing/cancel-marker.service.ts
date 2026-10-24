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
import { logger } from '@/services/logger.service'

const billingRepository = new BillingRepository()

/**
 * Record who is cancelling a subscription, before the provider is asked.
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
  await billingRepository.setCancelMarker(tenantId, {
    subscriptionId,
    by: marker.by,
    userId: marker.by === 'owner' ? marker.userId : null,
    at: new Date(),
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
