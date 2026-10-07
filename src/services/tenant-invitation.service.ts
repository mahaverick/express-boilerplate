/**
 * @file Invitations to join a tenant: invite, list, resend, revoke, preview, accept.
 * Multi-step writes run in one transaction with their audit entry, and every
 * query inside one goes through its `tx`. Audit metadata carries the address's
 * domain only; mail and the in-app notification are
 * enqueued after the write commits, fire-and-forget. A teammate invitation
 * and a claimed accept emit their domain event after commit.
 */
import { randomBytes } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import {
  INVITATION_TOKEN_BYTES,
  INVITEE_DEACTIVATED_CODE,
  type MembershipRole,
} from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { addEmailJob } from '@/jobs/email.job'
import { addNotificationJob } from '@/jobs/notification.job'
import { canActorGrantRole } from '@/policies/tenant.policy'
import {
  TenantInvitationRepository,
  type PendingInvitationSummary,
} from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import { hashToken } from '@/services/session.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import { buildInvitationAcceptUrl, frontendUrl } from '@/services/verification.service'
import { TENANT_INVITATION_TEMPLATE_KEY } from '@/templates/email/tenant-invitation.template'
import type { Actor } from '@/types/actor'
import type { DomainEventOf } from '@/types/domain-event'
import type { EmailResendOptions } from '@/types/email-context'
import type { EmailDelivery } from '@/types/email-delivery'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'

const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * Error code: the invited address already belongs to a member.
 */
export const ALREADY_MEMBER_CODE = 'already_member'

/**
 * The 409 for an owner invitation to the platform tenant, whose staff are invited from Staff.
 */
export const PLATFORM_OWNER_INVITATION_MESSAGE =
  'The platform tenant has no owner invitation; invite staff from Staff.'

/**
 * Message for `ALREADY_MEMBER_CODE`.
 */
export const ALREADY_MEMBER_MESSAGE = 'That person is already a member.'

/**
 * Error code: the token is unknown, expired, revoked, already used, or for
 * a deleted tenant. One code for all of them, on purpose.
 */
export const INVITATION_INVALID_CODE = 'invitation_invalid'

/**
 * Message for `INVITATION_INVALID_CODE`.
 */
export const INVITATION_INVALID_MESSAGE = 'This invitation is invalid or has expired.'

/**
 * Error code: the signed-in user's address is not the invited one.
 */
export const INVITATION_EMAIL_MISMATCH_CODE = 'invitation_email_mismatch'

/**
 * Message for `INVITATION_EMAIL_MISMATCH_CODE`.
 */
export const INVITATION_EMAIL_MISMATCH_MESSAGE =
  'This invitation was sent to a different email address.'

/**
 * Error code: the signed-in user's address is the invited one, but unverified.
 */
export const INVITATION_EMAIL_UNVERIFIED_CODE = 'invitation_email_unverified'

/**
 * Message for `INVITATION_EMAIL_UNVERIFIED_CODE`.
 */
export const INVITATION_EMAIL_UNVERIFIED_MESSAGE =
  'Verify your email address before accepting this invitation.'

/**
 * Error code: no pending invitation with that id in this tenant.
 */
export const INVITATION_NOT_FOUND_CODE = 'invitation_not_found'

const INVITATION_NOT_FOUND_MESSAGE = 'Invitation not found'
/**
 * Matches no membership: stands in for the invitee id when the address has no account.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const INVITER_NAME_FALLBACK = 'A teammate'
const GRANT_REFUSED_MESSAGE = 'Insufficient permissions to grant this role'
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * What the public preview shows a token holder.
 */
export interface InvitationPreview {
  tenant: { name: string; slug: string }
  role: MembershipRole
  invitedBy: { firstName: string | null; lastName: string | null } | null
  email: string
}

/**
 * The outcome of an accept: the tenant and the role the user now holds in it.
 */
export interface AcceptedInvitation {
  tenant: { name: string; slug: string }
  role: MembershipRole
}

/**
 * What an accept's transaction settles: the answer, and the membership it
 * added, when it added one.
 */
interface AcceptOutcome {
  accepted: AcceptedInvitation
  joined?: DomainEventOf<'invitation_accepted'>
}

/**
 * Everything the invitation email and notification are built from.
 */
export interface InvitationMessageContext {
  invitation: TenantInvitation
  rawToken: string
  tenant: { name: string; slug: string; isPlatform: boolean }
  inviterName: string
  invitee: User | undefined
}

/**
 * A fresh raw invitation token: 32 random bytes, base64url (43 characters).
 * @returns The raw token.
 */
function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('base64url')
}

/**
 * When an invitation issued now expires.
 * @returns Now plus `INVITATION_TTL`.
 */
function invitationExpiry(): Date {
  return new Date(Date.now() + requireDurationMs(getEnv().INVITATION_TTL))
}

/**
 * `INVITATION_TTL` in whole days, rounded up, for the email copy.
 * @returns At least "1".
 */
function expiresInDays(): string {
  const days = Math.ceil(requireDurationMs(getEnv().INVITATION_TTL) / MS_PER_DAY)
  return String(Math.max(1, days))
}

/**
 * A person's display name, or the fallback when they have none.
 * @param person - The inviter, if known.
 * @returns "First Last", whichever parts exist, or "A teammate".
 */
function inviterDisplayName(person: User | undefined): string {
  const name = [person?.firstName, person?.lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
  return name === '' ? INVITER_NAME_FALLBACK : name
}

/**
 * Whether the invitee should also get an in-app notification: a live,
 * active account whose address is verified.
 * @param user - The account owning the invited address, if any.
 * @returns True when an in-app notification should be enqueued.
 */
function isNotifiable(user: User | undefined): user is User {
  return user !== undefined && user.active && user.emailVerifiedAt !== null
}

/**
 * The domain the audit log keeps for an invited address.
 * @param email - The invited address.
 * @returns Its lowercased domain, or null when it has none or it is not a dotted hostname.
 */
function auditEmailDomain(email: string): string | null {
  // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
  return hostnameDomain(email) ?? null
}

/**
 * The 404 for a resend or revoke of an invitation that is not pending here.
 * @returns The error to throw.
 */
function invitationNotFound(): HttpError {
  return new HttpError(INVITATION_NOT_FOUND_MESSAGE, 404, INVITATION_NOT_FOUND_CODE)
}

/**
 * The one 404 for every token that cannot be previewed or accepted.
 * @returns The error to throw.
 */
function invitationInvalid(): HttpError {
  return new HttpError(INVITATION_INVALID_MESSAGE, 404, INVITATION_INVALID_CODE)
}

/**
 * Enqueue the invitation email, and the in-app notification when one is
 * due. The two enqueues are independent; a failure is logged, never thrown.
 * The email's message row records the tenant, the invitation and the
 * frontend the accept link opens.
 * @param context - The invitation and everything its messages need.
 * @param notifyUser - The verified invitee to notify in-app, if any.
 * @param options - `resentFromId` when a staff resend re-runs this for an earlier message.
 * @returns Whether the email job was enqueued.
 */
async function dispatchInvitationMessages(
  context: InvitationMessageContext,
  notifyUser: User | undefined,
  options: EmailResendOptions = {}
): Promise<EmailDelivery> {
  const { invitation, rawToken, tenant, inviterName } = context
  // Server-decided: staff are invited into Apex, everyone else into the customer app.
  const linkApp = tenant.isPlatform ? 'apex' : 'web'
  const acceptOrigin = frontendUrl(linkApp)
  const results = await Promise.allSettled([
    addEmailJob(
      {
        to: invitation.email,
        templateKey: TENANT_INVITATION_TEMPLATE_KEY,
        variables: {
          tenantName: tenant.name,
          inviterName,
          role: invitation.role,
          acceptUrl: buildInvitationAcceptUrl(rawToken, acceptOrigin),
          expiresInDays: expiresInDays(),
          appName: getEnv().APP_NAME,
        },
      },
      // The account the mail is for: '' (stored as NULL) when the address has none.
      context.invitee?.id ?? '',
      {
        context: {
          tenantId: invitation.tenantId,
          invitationId: invitation.id,
          linkApp,
          ...options,
        },
      }
    ),
    ...(notifyUser
      ? [
          // metadata never carries the token: the mailed link is the only way in.
          addNotificationJob({
            userId: notifyUser.id,
            type: 'tenant_invitation',
            title: `Invitation to ${tenant.name}`,
            body: `${inviterName} invited you to join as ${invitation.role}.`,
            metadata: { tenantSlug: tenant.slug, invitationId: invitation.id },
          }),
        ]
      : []),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error('Invitation message could not be enqueued', {
        error: result.reason,
        invitationId: invitation.id,
      })
    }
  }
  return { emailSent: results[0]?.status === 'fulfilled' }
}

/**
 * The tenant's name, slug and platform flag, for an invitation's messages.
 * @param tenantId - The tenant.
 * @param executor - Where to run the query. Defaults to the pool.
 * @returns Its name, slug and platform flag.
 * @throws {HttpError} 404, when the tenant is gone.
 */
async function tenantForMessages(
  tenantId: string,
  executor: DbExecutor = db
): Promise<{ name: string; slug: string; isPlatform: boolean }> {
  const tenant = await tenantRepository.findById(tenantId, {}, executor)
  if (!tenant) throw new HttpError('Tenant not found', 404)
  return { name: tenant.name, slug: tenant.slug, isPlatform: tenant.isPlatform }
}

/**
 * Invite an address to a tenant. Answers the same way whether or not the
 * address has an account; only an existing member is refused. The actor's
 * role is re-read under lock first, so the grant check runs before any
 * lookup of the address and holds until the invitation is written. After
 * commit it emits `teammate_invited` with the access the actor used; the
 * staff owner invitation and `resend` emit nothing.
 * @param actor - The signed-in user sending the invitation.
 * @param tenantId - The tenant.
 * @param email - The address to invite, in any case.
 * @param role - The role offered.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access, or when the tenant is gone; 403 when the actor is now below admin or may not grant `role`; 409 `already_member` when the address belongs to a member; 409 `invitation_conflict` from a racing duplicate invite.
 */
export async function invite(
  actor: Actor,
  tenantId: string,
  email: string,
  role: MembershipRole
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  const rawToken = generateInvitationToken()

  const { context, access } = await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    if (!canActorGrantRole(actorRole, role)) throw new HttpError(GRANT_REFUSED_MESSAGE, 403)

    const invitee = await userRepository.findByEmail(normalizedEmail, {}, tx)
    // Always run the lookup, so a registered and an unregistered address take the same queries.
    const membership = await userMembershipRepository.findByUserAndTenant(
      invitee?.id ?? NIL_UUID,
      tenantId,
      tx
    )
    if (invitee && membership) {
      throw new HttpError(ALREADY_MEMBER_MESSAGE, 409, ALREADY_MEMBER_CODE)
    }
    const tenant = await tenantForMessages(tenantId, tx)
    const inviter = await userRepository.findById(actor.userId, {}, tx)

    const invitation = await invitationRepository.createPending(
      {
        tenantId,
        email: normalizedEmail,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy: actor.userId,
        expiresAt: invitationExpiry(),
      },
      tx
    )
    await record(
      {
        action: 'invitation.created',
        actor,
        access,
        tenantId,
        targetId: invitation.id,
        metadata: { role, emailDomain: auditEmailDomain(normalizedEmail) },
      },
      tx
    )
    const written: InvitationMessageContext = {
      invitation,
      rawToken,
      tenant,
      inviterName: inviterDisplayName(inviter),
      invitee,
    }
    return { context: written, access }
  })

  const { invitee } = context
  // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the response must not wait on the queue
  dispatchInvitationMessages(context, isNotifiable(invitee) ? invitee : undefined).catch(
    (error: unknown) => {
      logger.error('Invitation messages failed', { error, invitationId: context.invitation.id })
    }
  )
  await emitDomainEvent(
    {
      type: 'teammate_invited',
      tenantId,
      actorId: actor.userId,
      at: context.invitation.createdAt,
    },
    { access }
  )
}

/**
 * An owner invitation written in the caller's transaction, waiting to be sent after commit.
 */
export interface OwnerInvitationDispatch {
  context: InvitationMessageContext
  notifyUser: User | undefined
}

/**
 * Write a pending `owner` invitation for a tenant that has no owner, inside
 * the caller's transaction, and audit it as `tenant.owner_invited`. For
 * staff only (platform-tenant.service.ts). The caller is behind
 * `requirePlatformRole('admin')` and has checked that the tenant is ownerless,
 * so `canActorGrantRole` is deliberately not applied: under platform access
 * an admin could never grant owner, and an ownerless tenant has nobody else
 * who can.
 * @param actor - The staff user.
 * @param tenantId - The ownerless tenant.
 * @param email - The address to invite, in any case. A staff member's own address is allowed; the audit entry records the invitee's account.
 * @param reason - The staff member's reason, or null for the invitation sent when the tenant is created.
 * @param tx - The caller's transaction.
 * @returns What `sendOwnerInvitation` needs once the transaction commits.
 * @throws {HttpError} 409 `invitee_deactivated` when the address belongs to a deactivated account; 409 `already_member` when it belongs to a member; 409 for the platform tenant; 409 `invitation_conflict` from a racing duplicate.
 */
export async function createOwnerInvitation(
  actor: Actor,
  tenantId: string,
  email: string,
  reason: string | null,
  tx: DbTransaction
): Promise<OwnerInvitationDispatch> {
  const normalizedEmail = email.trim().toLowerCase()
  const rawToken = generateInvitationToken()
  const invitee = await userRepository.findByEmail(normalizedEmail, {}, tx)
  if (invitee && !invitee.active) {
    throw new HttpError('That account is deactivated', 409, INVITEE_DEACTIVATED_CODE)
  }
  if (invitee && (await userMembershipRepository.findByUserAndTenant(invitee.id, tenantId, tx))) {
    throw new HttpError(ALREADY_MEMBER_MESSAGE, 409, ALREADY_MEMBER_CODE)
  }
  const tenant = await tenantForMessages(tenantId, tx)
  if (tenant.isPlatform) throw new HttpError(PLATFORM_OWNER_INVITATION_MESSAGE, 409)
  const inviter = await userRepository.findById(actor.userId, {}, tx)
  const invitation = await invitationRepository.createPending(
    {
      tenantId,
      email: normalizedEmail,
      role: 'owner',
      tokenHash: hashToken(rawToken),
      invitedBy: actor.userId,
      expiresAt: invitationExpiry(),
    },
    tx
  )
  await record(
    {
      action: 'tenant.owner_invited',
      actor,
      access: 'platform',
      tenantId,
      targetId: invitation.id,
      metadata: {
        emailDomain: auditEmailDomain(normalizedEmail),
        // eslint-disable-next-line unicorn/no-null -- JSON null: the address has no account yet
        inviteeUserId: invitee?.id ?? null,
        reason,
      },
    },
    tx
  )
  return {
    context: { invitation, rawToken, tenant, inviterName: inviterDisplayName(inviter), invitee },
    notifyUser: isNotifiable(invitee) ? invitee : undefined,
  }
}

/**
 * Enqueue an owner invitation's email and notification. Call after the
 * transaction that wrote it commits. Never throws.
 * @param dispatch - What `createOwnerInvitation` returned.
 * @returns Whether the email job was enqueued.
 */
export async function sendOwnerInvitation(
  dispatch: OwnerInvitationDispatch
): Promise<EmailDelivery> {
  try {
    return await dispatchInvitationMessages(dispatch.context, dispatch.notifyUser)
  } catch (error) {
    logger.error('Invitation messages failed', {
      error,
      invitationId: dispatch.context.invitation.id,
    })
    return { emailSent: false }
  }
}

/**
 * A tenant's pending, unexpired invitations, newest first.
 * @param tenantId - The tenant.
 * @returns One summary per invitation; never a token or its hash.
 */
export async function listPending(tenantId: string): Promise<PendingInvitationSummary[]> {
  return invitationRepository.listPending(tenantId)
}

/**
 * Give a pending invitation a new link and a fresh lifetime, and mail it
 * again. The old link stops working at once. Resending re-issues the
 * invitation's role, so the grant rule runs again, on the actor's role as
 * re-read under lock.
 * @param actor - The signed-in user resending it, named in the email.
 * @param tenantId - The tenant it must belong to.
 * @param invitationId - The invitation.
 * @param options - `resentFromId` when a staff resend re-runs this for an earlier message.
 * @throws {HttpError} 404 when the tenant is gone, before anything is written; 404 `Tenant not found` when the actor no longer has access; 403 when the actor is now below admin; 404 `invitation_not_found` when it is not pending in this tenant; 403 when the actor may not grant its role.
 */
export async function resend(
  actor: Actor,
  tenantId: string,
  invitationId: string,
  options: EmailResendOptions = {}
): Promise<void> {
  // Before the write, so a vanished tenant cannot leave the old link replaced and no email sent.
  const tenant = await tenantForMessages(tenantId)
  const rawToken = generateInvitationToken()
  const invitation = await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    const pending = await invitationRepository.findPendingById(tenantId, invitationId, tx)
    if (!pending) throw invitationNotFound()
    if (!canActorGrantRole(actorRole, pending.role)) {
      throw new HttpError(GRANT_REFUSED_MESSAGE, 403)
    }
    const updated = await invitationRepository.replaceToken(
      pending.id,
      hashToken(rawToken),
      invitationExpiry(),
      tx
    )
    if (!updated) throw invitationNotFound()
    await record(
      {
        action: 'invitation.resent',
        actor,
        access,
        tenantId,
        targetId: updated.id,
        metadata: { role: updated.role, emailDomain: auditEmailDomain(updated.email) },
      },
      tx
    )
    return updated
  })
  const inviter = await userRepository.findById(actor.userId)
  const invitee = await userRepository.findByEmail(invitation.email)

  const context = {
    invitation,
    rawToken,
    tenant,
    inviterName: inviterDisplayName(inviter),
    invitee,
  }
  // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the response must not wait on the queue
  dispatchInvitationMessages(context, undefined, options).catch((error: unknown) => {
    logger.error('Invitation messages failed', { error, invitationId: invitation.id })
  })
}

/**
 * Revoke a pending invitation. The actor's role is re-read under lock, and
 * the grant rule applies as it does to invite and resend: an admin cannot
 * revoke an owner or admin invitation it could not have sent.
 * @param actor - The signed-in user revoking it.
 * @param tenantId - The tenant it must belong to.
 * @param invitationId - The invitation.
 * @throws {HttpError} 404 `Tenant not found` when the actor no longer has access; 403 when the actor is now below admin; 404 `invitation_not_found` when it is not pending in this tenant; 403 when the actor may not grant its role.
 */
export async function revoke(actor: Actor, tenantId: string, invitationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    // Read first: the audit entry needs the role and address the revoke doesn't return.
    const pending = await invitationRepository.findPendingById(tenantId, invitationId, tx)
    if (!pending) throw invitationNotFound()
    if (!canActorGrantRole(actorRole, pending.role)) {
      throw new HttpError(GRANT_REFUSED_MESSAGE, 403)
    }
    const wasRevoked = await invitationRepository.revoke(tenantId, invitationId, tx)
    if (!wasRevoked) throw invitationNotFound()
    await record(
      {
        action: 'invitation.revoked',
        actor,
        access,
        tenantId,
        targetId: pending.id,
        metadata: { role: pending.role, emailDomain: auditEmailDomain(pending.email) },
      },
      tx
    )
  })
}

/**
 * What a valid token's holder may see before accepting.
 * @param rawToken - The raw token from the link.
 * @returns The tenant, role, inviter and invited address.
 * @throws {HttpError} 404 `invitation_invalid`, for any token that cannot be accepted.
 */
export async function preview(rawToken: string): Promise<InvitationPreview> {
  const valid = await invitationRepository.findValidByTokenHash(hashToken(rawToken))
  if (!valid) throw invitationInvalid()
  return {
    tenant: { name: valid.tenant.name, slug: valid.tenant.slug },
    role: valid.invitation.role,
    invitedBy: valid.invitedBy,
    email: valid.invitation.email,
  }
}

/**
 * Refuse the accept unless the user's address is the invited one and is
 * verified. A different address is reported first, whether or not verified.
 * @param user - The signed-in user's row.
 * @param invitedEmail - The invitation's stored (lowercased) address.
 * @throws {HttpError} 403 `invitation_email_mismatch` when the addresses differ; 403 `invitation_email_unverified` when they match but the user's is unverified.
 */
function assertInvitedAddress(user: User, invitedEmail: string): void {
  if (user.email.trim().toLowerCase() !== invitedEmail) {
    throw new HttpError(INVITATION_EMAIL_MISMATCH_MESSAGE, 403, INVITATION_EMAIL_MISMATCH_CODE)
  }
  if (user.emailVerifiedAt === null) {
    throw new HttpError(INVITATION_EMAIL_UNVERIFIED_MESSAGE, 403, INVITATION_EMAIL_UNVERIFIED_CODE)
  }
}

/**
 * The idempotent re-accept: succeed only when this user already accepted
 * this invitation and is a member of its tenant, and the tenant is active.
 * @param tokenHash - SHA-256 hex of the raw token.
 * @param userId - The signed-in user.
 * @param executor - The accept transaction.
 * @returns The tenant and the user's current role in it.
 * @throws {HttpError} 404 `invitation_invalid` otherwise.
 */
async function acceptedEarlierBy(
  tokenHash: string,
  userId: string,
  executor: DbExecutor
): Promise<AcceptedInvitation> {
  const found = await invitationRepository.findByTokenHash(tokenHash, executor)
  if (found?.invitation.acceptedBy !== userId) throw invitationInvalid()
  // A suspended tenant's invitations wait, for a returning accepter too.
  if (found.tenant.lifecycleState !== 'active') throw invitationInvalid()
  const membership = await userMembershipRepository.findByUserAndTenant(
    userId,
    found.invitation.tenantId,
    executor
  )
  if (!membership) throw invitationInvalid()
  return { tenant: { name: found.tenant.name, slug: found.tenant.slug }, role: membership.role }
}

/**
 * Accept an invitation as the signed-in user. Only the owner of the
 * verified invited address may accept; a second accept by them succeeds.
 * A claimed accept that adds a membership emits `invitation_accepted` after
 * commit, saying whether the tenant had no member before; an accept that
 * finds the user already a member, or a repeat accept, emits nothing.
 * @param rawToken - The raw token from the link.
 * @param userId - The signed-in user.
 * @returns The tenant and the role the user now holds (an existing membership's role is kept).
 * @throws {HttpError} 404 `invitation_invalid`; 403 `invitation_email_mismatch` when the address differs; 403 `invitation_email_unverified` when it matches but is unverified; 401 when the account is gone.
 */
export async function accept(rawToken: string, userId: string): Promise<AcceptedInvitation> {
  const tokenHash = hashToken(rawToken)
  // Before the transaction: this row needs no lock, and a pool query inside one can starve the pool.
  const user = await userRepository.findById(userId)
  if (!user?.active) throw new HttpError('Authentication required', 401)

  const outcome = await db.transaction(async (tx): Promise<AcceptOutcome> => {
    const valid = await invitationRepository.findValidByTokenHash(tokenHash, tx)
    if (!valid) return { accepted: await acceptedEarlierBy(tokenHash, user.id, tx) }

    assertInvitedAddress(user, valid.invitation.email)

    const claimed = await invitationRepository.claimForAccept(tokenHash, user.id, tx)
    // Unredeemable since the read (accept, revoke, resend, expiry, tenant suspended, archived or deleted): succeed only if this user accepted.
    if (!claimed) return { accepted: await acceptedEarlierBy(tokenHash, user.id, tx) }

    const row = { userId: user.id, tenantId: claimed.tenantId, role: claimed.role }
    const inserted = await userMembershipRepository.insertIfAbsent(row, tx)
    // An existing membership keeps its role; createIfAbsent reads it back.
    const membership = inserted ?? (await userMembershipRepository.createIfAbsent(row, tx))
    await record(
      {
        action: 'invitation.accepted',
        actor: { userId: user.id },
        access: 'member',
        tenantId: claimed.tenantId,
        targetId: membership.id,
        metadata: { role: membership.role, invitationId: claimed.id },
      },
      tx
    )
    const accepted = {
      tenant: { name: valid.tenant.name, slug: valid.tenant.slug },
      role: membership.role,
    }
    if (!inserted) return { accepted }
    const memberCount = await userMembershipRepository.countMemberships(claimed.tenantId, tx)
    return {
      accepted,
      joined: {
        type: 'invitation_accepted',
        tenantId: claimed.tenantId,
        userId: user.id,
        role: inserted.role,
        wasFirstMember: memberCount === 1,
        at: inserted.createdAt,
      },
    }
  })
  if (outcome.joined) await emitDomainEvent(outcome.joined, { access: 'member' })
  return outcome.accepted
}
