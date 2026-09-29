/**
 * @file Purge: the only hard delete, owner-only, for a user already
 * soft-deleted or a tenant already archived. Each purge runs in one
 * transaction, sets the audit trigger's setting it needs (and no other), and
 * records itself in the platform tenant. This file and retention.service.ts
 * are the only places that name those settings
 * (tests/unit/audit-purge-setting.test.ts).
 */
import { sql } from 'drizzle-orm'
import { HttpError } from '@/errors/http-error'
import { AuditLogRepository } from '@/repositories/audit-log.repository'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { PlatformUserRepository } from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { platformTenantOrThrow } from '@/services/platform-user.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import type { Actor } from '@/types/actor'
import { hostnameDomain } from '@/utilities/email.utilities'

const auditLogRepository = new AuditLogRepository()
const emailLogRepository = new EmailLogRepository()
const platformUserRepository = new PlatformUserRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * Permanently delete a soft-deleted user: redact them from the audit
 * entries they acted in, delete the mail log rows and invitations addressed
 * to their address up to their deletion, delete the row (the rest
 * cascades), and record `user.purged` in the platform tenant. A deleted
 * user's address can be claimed again, and those rows are keyed by the
 * address alone: when a live account holds it now, none of them is deleted,
 * since the database can't tell the purged user's from the new holder's.
 * Rows written after the deletion are kept either way.
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
    if (!(await userRepository.purgeDeleted(userId, tx))) {
      throw new HttpError('Delete the user before purging them', 409)
    }
    const platform = await platformTenantOrThrow(tx)
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
  })
}

/**
 * Permanently delete an archived customer tenant: delete its own audit
 * entries (the customer's data), then the row (settings, memberships and
 * invitations cascade), and record `tenant.purged` in the platform tenant.
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
    await assertStillPlatformRole(actor, 'owner', tx)
    const members = await userMembershipRepository.listByTenant(tenantId, tx)
    await tx.execute(
      sql`select set_config('app.audit_purge', 'on', true), set_config('app.audit_purge_before', 'infinity', true)`
    )
    await auditLogRepository.deleteForTenant(tenantId, tx)
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
  })
}
