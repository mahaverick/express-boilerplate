/**
 * @file What follows a committed billing change, read from the difference
 * between the row before and after it, never from the provider event that
 * caused it: an entitlements push to every member's open app, and the billing
 * emails and notifications (`sendBillingDiffEmails`), and the analytics events
 * (`emitBillingDiffAnalytics`): it is the one place they read the diff. Every write path that changes a billing row calls it after its
 * commit, never inside the transaction.
 */
import type { BillingHistorySource } from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { emitBillingDiffAnalytics } from '@/services/billing/billing-analytics.service'
import {
  sendBillingDiffEmails,
  type BillingDiffExtras,
} from '@/services/billing/billing-emails.service'
import { logger } from '@/services/logger.service'
import { emitEntitlementsChanged } from '@/services/notification-emitter.service'

const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()

/**
 * The billing columns a member's app shows, through its entitlements or its
 * billing page. A change to any of them is pushed to open apps.
 */
const VISIBLE_KEYS = [
  'state',
  'planId',
  'priceId',
  'trialEndsAt',
  'currentPeriodEnd',
  'cancelAtPeriodEnd',
  'pastDueSince',
  'haltedAt',
  'pausedAt',
  'nextPriceId',
  'nextAuthenticatedAt',
] as const satisfies readonly (keyof TenantBillingRecord)[]

/**
 * Whether two column values are the same.
 * @param a - One value.
 * @param b - The other.
 * @returns True when equal; dates compare by time.
 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/**
 * Tell every member's open app that a workspace's entitlements changed, so it
 * reads them again. Only members are told; the message carries the workspace
 * id and slug, nothing else. A workspace that is gone tells no one.
 * @param tenantId - The workspace.
 */
export async function publishEntitlementsChanged(tenantId: string): Promise<void> {
  const tenant = await tenantRepository.findById(tenantId)
  if (tenant === undefined) return
  const members = await membershipRepository.listByTenant(tenantId)
  await Promise.all(
    members.map((member) =>
      emitEntitlementsChanged(member.user.id, { tenantId, slug: tenant.slug })
    )
  )
}

/**
 * Act on a committed billing change: push it to members' open apps when
 * anything they see changed, and send the emails, notifications and
 * analytics events it calls for, each once however often the same change is
 * passed in. Never rejects:
 * the change is committed, and a missed push only delays the app until its
 * next read; a failed send is logged with ids only.
 * @param before - The row before the change.
 * @param after - The row after it.
 * @param source - What made the change.
 * @param extras - What the change did besides the row: the upgrade requests it fulfilled, and the member whose own action it was.
 */
export async function emitBillingDiff(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: BillingHistorySource,
  extras: BillingDiffExtras = {}
): Promise<void> {
  const changed = VISIBLE_KEYS.filter((key) => !isSameValue(before[key], after[key]))
  if (changed.length === 0) return
  logger.debug('Billing changed', {
    tenantId: after.tenantId,
    from: before.state,
    to: after.state,
    changed,
    source,
  })
  try {
    await publishEntitlementsChanged(after.tenantId)
  } catch (error) {
    logger.error('Could not push an entitlements change', { error, tenantId: after.tenantId })
  }
  await sendBillingDiffEmails(before, after, source, extras)
  await emitBillingDiffAnalytics(before, after, source, extras)
}
