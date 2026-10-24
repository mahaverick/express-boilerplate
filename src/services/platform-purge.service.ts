/**
 * @file Purge: the only hard delete of a user or a tenant, owner-only, for a
 * user already soft-deleted or a tenant already archived. Each purge runs in
 * one transaction, sets the audit trigger's settings it needs (and no
 * others), and records itself in the platform tenant. This file and
 * retention.service.ts are the only places that name the purge settings
 * (tests/unit/audit-purge-setting.test.ts); only this file names
 * `app.audit_redact`.
 */
import { sql } from 'drizzle-orm'
import { ANALYTICS_DELETION_DELAY_MS } from '@/constants/analytics.constants'
import {
  CANCEL_BUFFER_DAYS,
  PAYMENT_PROVIDER_UNAVAILABLE_CODE,
} from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type { UserMembership } from '@/database/models/user-membership.model'
import { isUnknownIdError } from '@/errors/billing-provider-errors'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { analyticsDeletionRepository } from '@/repositories/analytics-deletion.repository'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { BillingRepository } from '@/repositories/billing.repository'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import { PlatformUserRepository } from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { enqueueAnalytics } from '@/services/analytics/analytics-outbox.service'
import { record } from '@/services/audit.service'
import { callProvider, getBillingProvider } from '@/services/billing/billing-provider.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import type { Actor } from '@/types/actor'
import type { ProviderSubscription } from '@/types/billing'
import { isOtherProvider } from '@/utilities/billing-rules.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'

const auditLogRepository = new AuditLogRepository()
const billingRepository = new BillingRepository()
const emailLogRepository = new EmailLogRepository()
const emailMessageRepository = new EmailMessageRepository()
const emailSuppressionRepository = new EmailSuppressionRepository()
const platformUserRepository = new PlatformUserRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()
const userTokenRepository = new UserTokenRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The refusal of a purge while a subscription may still charge a card.
 */
const LIVE_SUBSCRIPTION_MESSAGE = "Cancel this tenant's subscription before you purge it."

/**
 * Provider statuses after which a subscription can never charge again.
 */
const ENDED_STATUSES: ReadonlySet<ProviderSubscription['status']> = new Set([
  'cancelled',
  'completed',
  'expired',
])

/**
 * The refusal when the provider does not know a subscription the row holds.
 * Razorpay never deletes one, so it means this server's keys belong to
 * another account than the one that created it.
 */
const UNKNOWN_SUBSCRIPTION_MESSAGE =
  "The payment provider doesn't know this tenant's subscription, so nothing was purged. Check that this server uses the account that created it."

/**
 * The refusal when the provider refuses the purge's read.
 */
const PURGE_CHECK_REFUSED_MESSAGE =
  "The payment provider refused our check of this tenant's subscription, so nothing was purged. Try again in a few minutes. If it fails again, check the provider keys."

/**
 * Every subscription id a billing row holds: current, checkout and scheduled switch.
 * @param row - The billing row.
 * @returns The ids.
 */
function heldIds(row: TenantBillingRecord): string[] {
  return [row.providerSubscriptionId, row.pendingSubscriptionId, row.nextSubscriptionId].filter(
    (id) => id !== null
  )
}

/**
 * The subscriptions a billing row may still be charged through by its
 * state alone, for when the provider can't be asked: the current one while
 * the row pays (a cancelling one until its period and buffer have passed),
 * and any checkout or scheduled switch. A Free row keeps its last
 * subscription's id, which this leaves out.
 * @param row - The billing row.
 * @param now - The time of the purge.
 * @returns The ids.
 */
function possiblyLiveIds(row: TenantBillingRecord, now: Date): string[] {
  const ids: string[] = []
  const isPaying = row.state === 'active' || row.state === 'past_due'
  const bufferEnd =
    row.currentPeriodEnd === null
      ? null
      : row.currentPeriodEnd.getTime() + CANCEL_BUFFER_DAYS * DAY_MS
  const isPastBuffer = row.cancelAtPeriodEnd && bufferEnd !== null && bufferEnd < now.getTime()
  if (isPaying && !isPastBuffer && row.providerSubscriptionId !== null) {
    ids.push(row.providerSubscriptionId)
  }
  for (const id of [row.pendingSubscriptionId, row.nextSubscriptionId]) {
    if (id !== null) ids.push(id)
  }
  return ids
}

/**
 * What the purge's provider check covered, for the re-check under lock.
 */
interface PurgeCheck {
  /**
   * Which ids of a row the check is about: every held one when the provider
   * was asked, else those the row's state may still charge through.
   */
  idsOf: (row: TenantBillingRecord) => string[]
  /**
   * The ids the check found ended.
   */
  checked: ReadonlySet<string>
}

/**
 * Refuse the purge of a workspace whose subscription may still charge a
 * card. When the running provider can read the row, every id it holds is
 * read, whatever the row's state (a failed cancel can leave a Free row
 * holding a halted subscription): any status but cancelled, completed or
 * expired refuses with 409, and an id the provider does not know refuses with
 * 502. A purge never proceeds blind: a provider failure refuses with 503 or
 * 502, and so does a row the running provider cannot read (payments off, or
 * another provider or mode) whose state may still charge. Runs before the
 * purge's transaction, since no provider call happens inside one.
 * @param row - The workspace's billing row.
 * @param now - The time of the purge.
 * @returns What the check covered.
 * @throws {HttpError} 409 while a subscription runs; 502 for an unknown subscription or a row this server can't read; 503 or 502 when the provider fails.
 */
async function assertNoLiveSubscription(row: TenantBillingRecord, now: Date): Promise<PurgeCheck> {
  const provider = getBillingProvider()
  if (provider === null || isOtherProvider(row, provider)) {
    if (possiblyLiveIds(row, now).length > 0) {
      throw new HttpError(
        "This server can't reach the tenant's subscription. Cancel it in the provider's dashboard, then purge from a server that has payments on.",
        502,
        PAYMENT_PROVIDER_UNAVAILABLE_CODE
      )
    }
    return { idsOf: (locked) => possiblyLiveIds(locked, now), checked: new Set() }
  }
  const ids = heldIds(row)
  for (const id of ids) {
    const sub = await callProvider(async () => {
      try {
        return await provider.fetchSubscription(id)
      } catch (error) {
        if (!isUnknownIdError(error)) throw error
        throw new HttpError(UNKNOWN_SUBSCRIPTION_MESSAGE, 502, PAYMENT_PROVIDER_UNAVAILABLE_CODE)
      }
    }, PURGE_CHECK_REFUSED_MESSAGE)
    if (!ENDED_STATUSES.has(sub.status)) throw new HttpError(LIVE_SUBSCRIPTION_MESSAGE, 409)
  }
  return { idsOf: heldIds, checked: new Set(ids) }
}

/**
 * Lock every membership row of a user, in the order every membership write
 * takes: each customer tenant's owner rows then the user's membership there
 * (tenant-id order), then the same on the platform tenant. A role change or
 * removal running at the same time waits here, before the purge has locked
 * anything else, instead of deadlocking against the purge's delete.
 * @param userId - The user being purged.
 * @param platformTenantId - The platform tenant, whose rows are locked last.
 * @param tx - The purge's transaction.
 * @returns The user's memberships, locked FOR UPDATE.
 */
async function lockMembershipsForPurge(
  userId: string,
  platformTenantId: string,
  tx: DbTransaction
): Promise<UserMembership[]> {
  const tenantIds = await userMembershipRepository.listTenantIdsForUser(userId, tx)
  const customerTenantIds = tenantIds
    .filter((tenantId) => tenantId !== platformTenantId)
    .toSorted((a, b) => a.localeCompare(b))
  const ordered = tenantIds.includes(platformTenantId)
    ? [...customerTenantIds, platformTenantId]
    : customerTenantIds
  const locked: UserMembership[] = []
  for (const tenantId of ordered) {
    await userMembershipRepository.lockOwners(tenantId, 'update', tx)
    locked.push(
      ...(await userMembershipRepository.lockMemberships(tenantId, [userId], 'update', tx))
    )
  }
  return locked
}

/**
 * Permanently delete a soft-deleted user: redact them from the audit entries
 * they acted in, delete the email messages (with their attempts and events)
 * sent to their account, delete the mail log rows, email messages,
 * invitations and emailed links addressed to their address up to their deletion, forget them as
 * the lifter of any email suppression, forget them as payer with the billing
 * address they gave, delete their memberships (locked first,
 * in the membership lock order) and then the row (the rest cascades), record
 * `user.purged` in the platform tenant, queue the deletion of their PostHog
 * person, events and recordings (`analytics_deletions`, sent an hour later by
 * the `analytics-deletions` job), and delete their undelivered analytics outbox
 * rows, so none is sent after the deletion and recreates the person. A deleted
 * user's address can be claimed again, and the address-keyed rows are keyed by
 * the address alone: when a live account holds it at the time of the purge,
 * none of them is deleted, since the database can't tell the purged user's from
 * the new holder's. Rows written after the deletion are kept either way. Email
 * suppressions stay: they belong to the address, and dropping one would let
 * mail reach a mailbox known to bounce or complain.
 * @param actor - The platform owner, recently authenticated.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the transaction commits.
 * @throws {HttpError} 401 when the actor's own account was deleted or deactivated meanwhile; 404 unknown user or the actor lost the owner role; 409 when the user is not soft-deleted.
 */
export async function purgeUser(actor: Actor, userId: string, reason: string): Promise<void> {
  const found = await platformUserRepository.findRecord(userId, { includeDeleted: true })
  if (!found) throw notFoundError('user')
  const { deletedAt } = found
  if (deletedAt === null) throw new HttpError('Delete this user before you purge them.', 409)

  await withTransaction(async (tx) => {
    const platform = await platformTenantOrThrow(tx)
    // First, before any other lock: the delete below would otherwise take these rows out of order.
    const memberships = await lockMembershipsForPurge(userId, platform.id, tx)
    await assertStillPlatformRole(actor, 'owner', tx)
    // The foreign key clears only the payer id; the billing address they gave goes too.
    await billingRepository.clearPayer(userId, tx)
    await tx.execute(sql`select set_config('app.audit_redact', 'on', true)`)
    await auditLogRepository.redactActor(userId, tx)
    // Live accounts only: the purged user is soft-deleted, so any match is someone else.
    const holder = await userRepository.findByEmail(found.email, {}, tx)
    if (!holder) {
      await emailLogRepository.deleteByRecipient(found.email, deletedAt, tx)
      // Invitations addressed to the person hold the address too, pending or not.
      await tenantInvitationRepository.deleteForEmail(found.email, deletedAt, tx)
      // Sign-in links carry the address and no user id, so the user row's cascade never reaches them.
      await userTokenRepository.deleteForEmail(found.email, deletedAt, tx)
    }
    await emailMessageRepository.deleteForUser(
      userId,
      holder ? undefined : { address: found.email, createdAtOrBefore: deletedAt },
      tx
    )
    await emailSuppressionRepository.clearLiftedBy(userId, tx)
    // Deleted here, under the locks taken above, so the user row's cascade finds none.
    for (const membership of memberships) await userMembershipRepository.delete(membership.id, tx)
    if (!(await userRepository.purgeDeleted(userId, tx))) {
      throw new HttpError('Delete this user before you purge them.', 409)
    }
    await record(
      {
        action: 'user.purged',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: userId,
        metadata: { reason, emailDomain: hostnameDomain(found.email) ?? null },
      },
      tx
    )
    // Whatever the analytics config: events may have reached PostHog under an earlier one.
    await analyticsDeletionRepository.insert(
      userId,
      new Date(Date.now() + ANALYTICS_DELETION_DELAY_MS),
      tx
    )
    await analyticsOutboxRepository.deleteForDistinctId(userId, tx)
  })
}

/**
 * Permanently delete an archived customer tenant: delete its own audit
 * entries (the customer's data) and its email messages (which carry its
 * name), then the row (settings, billing, memberships and invitations cascade; the
 * memberships are locked first, in the membership lock order),
 * record `tenant.purged` in the platform tenant, and queue a `$groupidentify`
 * marker for it, which the drainer sends with the group's name cleared and
 * its status `purged`: PostHog cannot delete a group (ARCHITECTURE.md, "Analytics").
 * `memberCount` counts the members whose accounts are not soft-deleted.
 * Refused while its subscription may still charge a card
 * (`assertNoLiveSubscription`): the archive's cancel job cancels it, and the
 * purge then goes through. The purge is not queued: this request is where
 * the delete happens, so the check runs here, and again under the billing
 * row's lock for a subscription that arrived meanwhile.
 * @param actor - The platform owner, recently authenticated.
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the transaction commits.
 * @throws {HttpError} 401 when the actor's own account was deleted or deactivated meanwhile; 404 unknown tenant or the actor lost the owner role; 409 for the platform tenant, a tenant that is not archived, or one whose subscription still runs; 503 when the provider does not answer; 502 when it refuses the read, does not know a subscription the row holds, or this server can't reach it.
 */
export async function purgeTenant(actor: Actor, tenantId: string, reason: string): Promise<void> {
  const found = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (!found) throw notFoundError('platformTenant')
  if (found.isPlatform || found.lifecycleState !== 'archived') {
    throw new HttpError('Archive this tenant before you purge it.', 409)
  }
  const now = new Date()
  const billing = await billingRepository.findByTenantId(tenantId)
  const check: PurgeCheck =
    billing === undefined
      ? { idsOf: heldIds, checked: new Set() }
      : await assertNoLiveSubscription(billing, now)

  await withTransaction(async (tx) => {
    // The tenant's owner rows, then every membership, before the platform role: the order every membership write takes.
    await userMembershipRepository.lockOwners(tenantId, 'update', tx)
    await userMembershipRepository.lockAllMemberships(tenantId, 'update', tx)
    await assertStillPlatformRole(actor, 'owner', tx)
    // The seat lock's place: a webhook's sync may have brought a subscription in since the check.
    const locked = await billingRepository.lockByTenantId(tenantId, tx)
    if (locked !== undefined && check.idsOf(locked).some((id) => !check.checked.has(id))) {
      throw new HttpError(LIVE_SUBSCRIPTION_MESSAGE, 409)
    }
    const members = await userMembershipRepository.listByTenant(tenantId, tx)
    await tx.execute(
      sql`select set_config('app.audit_purge', 'on', true), set_config('app.audit_purge_before', 'infinity', true)`
    )
    await auditLogRepository.deleteForTenant(tenantId, tx)
    await emailMessageRepository.deleteForTenant(tenantId, tx)
    if (!(await tenantRepository.purgeArchived(tenantId, tx))) {
      throw new HttpError('Archive this tenant before you purge it.', 409)
    }
    const platform = await platformTenantOrThrow(tx)
    await record(
      {
        action: 'tenant.purged',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: tenantId,
        metadata: { reason, name: found.name, slug: found.slug, memberCount: members.length },
      },
      tx
    )
    // The drainer finds no tenant row for this marker, so it clears the group's name in PostHog.
    await enqueueAnalytics(
      [buildTenantGroupIdentify({ id: tenantId }, currentAnalyticsContext(), 'audit', new Date())],
      tx
    )
  })
}
