/**
 * @file Purge: the only hard delete, owner-only, for a user already
 * soft-deleted or a tenant already archived. Each purge runs in one
 * transaction, sets the audit trigger's setting it needs (and no other), and
 * records itself in the platform tenant. This file and retention.service.ts
 * are the only places that name those settings
 * (tests/unit/audit-purge-setting.test.ts).
 */
import { sql } from 'drizzle-orm'
import { ANALYTICS_DELETION_DELAY_MS } from '@/constants/analytics.constants'
import type { UserMembership } from '@/database/models/user-membership.model'
import { HttpError } from '@/errors/http-error'
import { analyticsDeletionRepository } from '@/repositories/analytics-deletion.repository'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { EmailSuppressionRepository } from '@/repositories/email-suppression.repository'
import { PlatformUserRepository } from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import { buildTenantGroupIdentify } from '@/services/analytics/analytics-event-builder.service'
import { enqueueAnalytics } from '@/services/analytics/analytics-outbox.service'
import { record } from '@/services/audit.service'
import { withTransaction, type DbTransaction } from '@/services/database.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import type { Actor } from '@/types/actor'
import { hostnameDomain } from '@/utilities/email.utilities'

const auditLogRepository = new AuditLogRepository()
const emailLogRepository = new EmailLogRepository()
const emailMessageRepository = new EmailMessageRepository()
const emailSuppressionRepository = new EmailSuppressionRepository()
const platformUserRepository = new PlatformUserRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

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
 * Permanently delete a soft-deleted user: redact them from the audit
 * entries they acted in, delete the email messages (with their attempts and
 * events) sent to their account, delete the mail log rows, email messages
 * and invitations addressed to their address up to their deletion, forget
 * them as the lifter of any email suppression, delete their memberships
 * (locked first, in the membership lock order) and then the row (the rest
 * cascades), record `user.purged` in the platform tenant, queue the deletion
 * of their PostHog person, events and recordings (`analytics_deletions`, sent
 * an hour later by the `analytics-deletions` job), and delete their
 * undelivered analytics outbox rows, so none is sent after the deletion and
 * recreates the person. A deleted
 * user's address can be claimed again, and the address-keyed rows are keyed
 * by the address alone: when a live account holds it now, none of them is
 * deleted, since the database can't tell the purged user's from the new
 * holder's. Rows written after the deletion are kept either way. Email
 * suppressions stay: they belong to the address, and dropping one would let
 * mail reach a mailbox known to bounce or complain.
 * @param actor - The platform owner, recently authenticated.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the transaction commits.
 * @throws {HttpError} 401 when the actor's own account was deleted or deactivated meanwhile; 404 unknown user or the actor is no longer an owner; 409 when the user is not soft-deleted.
 */
export async function purgeUser(actor: Actor, userId: string, reason: string): Promise<void> {
  const found = await platformUserRepository.findRecord(userId, { includeDeleted: true })
  if (!found) throw new HttpError('User not found', 404)
  const { deletedAt } = found
  if (deletedAt === null) throw new HttpError('Delete the user before purging them', 409)

  await withTransaction(async (tx) => {
    const platform = await platformTenantOrThrow(tx)
    // First, before any other lock: the delete below would otherwise take these rows out of order.
    const memberships = await lockMembershipsForPurge(userId, platform.id, tx)
    await assertStillPlatformRole(actor, 'owner', tx)
    await tx.execute(sql`select set_config('app.audit_redact', 'on', true)`)
    await auditLogRepository.redactActor(userId, tx)
    // Live accounts only: the purged user is soft-deleted, so any match is someone else.
    const holder = await userRepository.findByEmail(found.email, {}, tx)
    if (!holder) {
      await emailLogRepository.deleteByRecipient(found.email, deletedAt, tx)
      // Invitations addressed to the person hold the address too, pending or not.
      await tenantInvitationRepository.deleteForEmail(found.email, deletedAt, tx)
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
      throw new HttpError('Delete the user before purging them', 409)
    }
    await record(
      {
        action: 'user.purged',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: userId,
        // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
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
 * name), then the row (settings, memberships and invitations cascade; the
 * memberships are locked first, in the membership lock order),
 * record `tenant.purged` in the platform tenant, and queue a `$groupidentify`
 * marker for it, which the drainer sends with the group's name cleared and
 * its status `purged` (PostHog cannot reliably delete a group).
 * `memberCount` counts the members whose accounts are not soft-deleted.
 * @param actor - The platform owner, recently authenticated.
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the transaction commits.
 * @throws {HttpError} 401 when the actor's own account was deleted or deactivated meanwhile; 404 unknown tenant or the actor is no longer an owner; 409 for the platform tenant or a tenant that is not archived.
 */
export async function purgeTenant(actor: Actor, tenantId: string, reason: string): Promise<void> {
  const found = await tenantRepository.findByIdIncludingDeleted(tenantId)
  if (!found) throw new HttpError('Tenant not found', 404)
  if (found.isPlatform || found.lifecycleState !== 'archived') {
    throw new HttpError('Archive the tenant before purging it', 409)
  }

  await withTransaction(async (tx) => {
    // The tenant's owner rows, then every membership, before the platform role: the order every membership write takes.
    await userMembershipRepository.lockOwners(tenantId, 'update', tx)
    await userMembershipRepository.lockAllMemberships(tenantId, 'update', tx)
    await assertStillPlatformRole(actor, 'owner', tx)
    const members = await userMembershipRepository.listByTenant(tenantId, tx)
    await tx.execute(
      sql`select set_config('app.audit_purge', 'on', true), set_config('app.audit_purge_before', 'infinity', true)`
    )
    await auditLogRepository.deleteForTenant(tenantId, tx)
    await emailMessageRepository.deleteForTenant(tenantId, tx)
    if (!(await tenantRepository.purgeArchived(tenantId, tx))) {
      throw new HttpError('Archive the tenant before purging it', 409)
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
