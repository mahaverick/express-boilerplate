/**
 * @file Invitations to join a tenant: invite, list, resend, revoke, preview,
 * accept, and the one-click verify that signs the invitee in and joins them,
 * creating their account when the address has none. Multi-step writes run in one transaction with their audit entry,
 * and every query inside one goes through its `tx`. Audit metadata carries
 * the address's domain, never the address. Mail and the in-app notification
 * are enqueued after the write commits, and a failed enqueue is logged,
 * never thrown. A teammate invitation and an accept that adds a membership
 * emit their domain event after commit.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { getEnv } from '@/configs/env.config'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import { RATE_LIMITED_CODE } from '@/constants/rate-limit.constants'
import {
  INVITATION_TOKEN_BYTES,
  INVITEE_DEACTIVATED_CODE,
  type MembershipRole,
} from '@/constants/tenant.constants'
import type { TenantInvitation } from '@/database/models/tenant-invitation.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import type { InvalidCursorError } from '@/errors/list-errors'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'
import { redactedForLog } from '@/errors/postgres-errors'
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
import {
  claimNeverVerifiedAccount,
  clearSquatterCredentials,
  createLinkedAccount,
  isAddressTaken,
  isClaimedAccountGone,
} from '@/services/account-claim.service'
import { record } from '@/services/audit.service'
import { platformRoleForLogin } from '@/services/auth.service'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { emitDomainEvent } from '@/services/domain-events.service'
import { spendInvitationRecipientBudget } from '@/services/invitation-recipient-limit.service'
import { logger } from '@/services/logger.service'
import { getMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { assertSignInAllowed } from '@/services/maintenance-mode/maintenance-mode.service'
import {
  hashToken,
  issueRefreshToken,
  signAccessToken,
  type IssuedRefreshToken,
} from '@/services/session.service'
import {
  assertStaffReasonGiven,
  lockActorRole,
  lockUserForOwnership,
} from '@/services/tenant-membership.service'
import { buildInvitationAcceptUrl, frontendUrl } from '@/services/verification.service'
import { TENANT_INVITATION_TEMPLATE_KEY } from '@/templates/email/tenant-invitation.template'
import type { Actor, StaffReasonOption } from '@/types/actor'
import type { DomainEventOf } from '@/types/domain-event'
import type { EmailResendOptions } from '@/types/email-context'
import type { EmailDelivery } from '@/types/email-delivery'
import { formatWait, requireDurationMs } from '@/utilities/duration.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'
import type { InvitationListQuery } from '@/validators/tenant.validators'

const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

/**
 * Error code: the invited address already belongs to a member.
 */
const ALREADY_MEMBER_CODE = 'already_member'

/**
 * The 409 for an owner invitation to the platform tenant, whose staff are invited from Staff.
 */
export const PLATFORM_OWNER_INVITATION_MESSAGE =
  'The platform tenant has no owner invitation; invite staff from Staff.'

/**
 * Message for `ALREADY_MEMBER_CODE`.
 */
const ALREADY_MEMBER_MESSAGE =
  'That person is already a member of this workspace. No invitation was sent.'

/**
 * Error code: the token is unknown, expired, revoked, already used, or for a
 * tenant that is deleted or not active. One code for all of them, on purpose.
 */
export const INVITATION_INVALID_CODE = 'invitation_invalid'

/**
 * Message for `INVITATION_INVALID_CODE`.
 */
export const INVITATION_INVALID_MESSAGE =
  'This invitation link has expired or was already used. Ask the person who invited you for a new one.'

/**
 * Error code: the signed-in user's address is not the invited one.
 */
const INVITATION_EMAIL_MISMATCH_CODE = 'invitation_email_mismatch'

/**
 * Message for `INVITATION_EMAIL_MISMATCH_CODE`.
 */
const INVITATION_EMAIL_MISMATCH_MESSAGE =
  'This invitation is for a different email address. Sign in with the address it was sent to.'

/**
 * Error code: the signed-in user's address is the invited one, but unverified.
 */
const INVITATION_EMAIL_UNVERIFIED_CODE = 'invitation_email_unverified'

/**
 * Message for `INVITATION_EMAIL_UNVERIFIED_CODE`.
 */
const INVITATION_EMAIL_UNVERIFIED_MESSAGE =
  'Confirm your email address before you accept this invitation. Open the invitation link from your inbox.'

/**
 * Error code: no pending invitation with that id in this tenant.
 */
const INVITATION_NOT_FOUND_CODE = 'invitation_not_found'

/**
 * Error code: a resend inside `INVITATION_RESEND_COOLDOWN` of the invitation's last send.
 */
const INVITATION_RESEND_COOLDOWN_CODE = 'invitation_resend_cooldown'

/**
 * The 429 message when an address has had its day's share of invitation mail.
 */
const INVITATION_RECIPIENT_LIMITED_MESSAGE =
  'This address has reached its daily invitation limit. Try again in 24 hours.'

const INVITATION_NOT_FOUND_MESSAGE = 'Invitation not found'
/**
 * Matches no membership: stands in for the invitee id when the address has no account.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const INVITER_NAME_FALLBACK = 'A teammate'
const GRANT_REFUSED_MESSAGE = "Your role can't grant this role. Ask a workspace owner."
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
 * The outcome of an accept: the tenant, the role the user holds in it, and
 * whether this accept added no membership (the user had joined already, by
 * this invitation or otherwise), so the client can say "You've already joined".
 */
export interface AcceptedInvitation {
  tenant: { name: string; slug: string }
  role: MembershipRole
  alreadyMember: boolean
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
 * A one-click verify that joined: the account, its new session's tokens, its
 * platform role, whether this click created it, and the tenant and role it
 * holds there.
 */
export interface InvitationSession {
  user: User
  accessToken: string
  refreshToken: IssuedRefreshToken
  platformRole: MembershipRole | null
  isNewUser: boolean
  tenant: { name: string; slug: string }
  role: MembershipRole
}

/**
 * What a verify's transaction settles: the account, its session, the role it
 * holds, and the membership it added, when it added one.
 */
interface VerifyOutcome {
  user: User
  refreshToken: IssuedRefreshToken
  role: MembershipRole
  joined?: DomainEventOf<'invitation_accepted'>
}

/**
 * Everything the invitation email and notification are built from.
 */
interface InvitationMessageContext {
  invitation: TenantInvitation
  rawToken: string
  tenant: { name: string; slug: string; isPlatform: boolean }
  inviterName: string
  invitee: User | undefined
  /**
   * The mail's "expires in" days when the invitation keeps an earlier
   * expiry; the full `INVITATION_TTL` when absent.
   */
  expiresInDays?: string
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
 * The whole days an invitation has left, for a mail about one that keeps its
 * expiry: rounded down, so the mail never promises time past `expires_at`,
 * and at least 1, so it never says 0 days for a link that still works.
 * @param expiresAt - The invitation's expiry.
 * @param now - The time the mail is composed.
 * @returns The day count, as the template's variable.
 */
function daysLeftUntil(expiresAt: Date, now: Date = new Date()): string {
  const days = Math.floor((expiresAt.getTime() - now.getTime()) / MS_PER_DAY)
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
 * Refuse an invitation mail the recipient's daily budget has no room for.
 * Call it after the transaction's last write that can fail, so a refusal
 * rolls those writes back and an attempt refused earlier spends nothing.
 * @param email - The invited address.
 * @param tenantId - The tenant sending it, whose share of the budget is counted too.
 * @throws {HttpError} 429 `RATE_LIMITED` when the tenant has had its share of the address's invitation mails in the window, or the address has had `INVITATION_RECIPIENT_DAILY_LIMIT`.
 */
async function assertRecipientBudget(email: string, tenantId: string): Promise<void> {
  if ((await spendInvitationRecipientBudget(email, tenantId)) === 'exhausted') {
    throw new HttpError(INVITATION_RECIPIENT_LIMITED_MESSAGE, 429, RATE_LIMITED_CODE)
  }
}

/**
 * When a resend of an invitation last mailed at `lastSentAt` is allowed.
 * @param lastSentAt - When it was last mailed, or null for a row never stamped.
 * @returns The instant the cooldown ends, or null when it is over or never began.
 */
export function resendAvailableAt(lastSentAt: Date | null): Date | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null when no cooldown applies
  if (lastSentAt === null) return null
  const availableAt = new Date(
    lastSentAt.getTime() + requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN)
  )
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null once the cooldown is over
  return availableAt.getTime() > Date.now() ? availableAt : null
}

/**
 * The 429 for a resend inside the cooldown, carrying `Retry-After`.
 * @param lastSentAt - When the invitation was last mailed.
 * @returns The error to throw; `retryAfterSeconds` is the whole seconds left, at least 1.
 */
function resendCooldownError(lastSentAt: Date | null): HttpError {
  const availableAt = resendAvailableAt(lastSentAt)
  const secondsLeft =
    availableAt === null ? 1 : Math.ceil((availableAt.getTime() - Date.now()) / 1000)
  const retryAfterSeconds = Math.max(1, secondsLeft)
  return new HttpError(
    `You can resend this invitation in ${formatWait(retryAfterSeconds)}.`,
    429,
    INVITATION_RESEND_COOLDOWN_CODE,
    undefined,
    { retryAfterSeconds }
  )
}

/**
 * Refuse a resend sooner than `INVITATION_RESEND_COOLDOWN` after the
 * invitation's last send. A row never stamped is let through.
 * @param invitation - The pending invitation.
 * @throws {HttpError} 429 `invitation_resend_cooldown` inside the cooldown, with `Retry-After`.
 */
function assertResendCooldownOver(invitation: TenantInvitation): void {
  if (isInsideResendCooldown(invitation)) throw resendCooldownError(invitation.lastSentAt)
}

/**
 * Whether an invitation was last mailed less than
 * `INVITATION_RESEND_COOLDOWN` ago. A row never stamped is not.
 * @param invitation - The pending invitation.
 * @returns True inside the cooldown.
 */
function isInsideResendCooldown(invitation: TenantInvitation): boolean {
  if (invitation.lastSentAt === null) return false
  const elapsedMs = Date.now() - invitation.lastSentAt.getTime()
  return elapsedMs < requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN)
}

/**
 * Thrown inside the sign-in resend's transaction when the address has had
 * its day's invitation mail, so the token swap rolls back; caught and
 * dropped, since a refused resend is silent.
 */
class RecipientBudgetSpentError extends Error {}

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
          expiresInDays: context.expiresInDays ?? expiresInDays(),
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
 * @param options - `reason` when staff invite through platform access, recorded in the audit entry.
 * @throws {HttpError} 404 `Tenant not found` when the actor lost access, or when the tenant is gone; 403 when the actor is below admin or may not grant `role`; 409 `already_member` when the address belongs to a member; 429 `RATE_LIMITED` when the address has had its day's invitation mail, or this tenant its share of it; 409 `invitation_conflict` from a racing duplicate invite; 400 `REASON_REQUIRED` when the locked re-read finds platform access and no reason was given.
 */
export async function invite(
  actor: Actor,
  tenantId: string,
  email: string,
  role: MembershipRole,
  options: StaffReasonOption = {}
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  const rawToken = generateInvitationToken()

  const { context, access } = await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    assertStaffReasonGiven(access, options)
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
    // After the writes that can fail, so a 404 or a 409 spends nothing; a refusal rolls the insert back.
    await assertRecipientBudget(normalizedEmail, tenantId)
    await record(
      {
        action: 'invitation.created',
        actor,
        access,
        tenantId,
        targetId: invitation.id,
        metadata: {
          role,
          emailDomain: auditEmailDomain(normalizedEmail),
          ...(options.reason !== undefined && { reason: options.reason }),
        },
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
    throw new HttpError(
      'This account is deactivated. Reactivate it before you invite it as owner.',
      409,
      INVITEE_DEACTIVATED_CODE
    )
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
 * One pending invitation as the list returns it: the stored summary and when a resend opens up.
 */
export type PendingInvitationItem = PendingInvitationSummary & { resendAvailableAt: Date | null }

/**
 * One page of a tenant's pending, unexpired invitations.
 * @param tenantId - The tenant.
 * @param query - The parsed list query.
 * @returns The page; never a token or its hash.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listPending(
  tenantId: string,
  query: InvitationListQuery
): Promise<ListPage<PendingInvitationItem>> {
  const page = await invitationRepository.listPending(tenantId, query.params, {
    roles: query.filters.role,
  })
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      resendAvailableAt: resendAvailableAt(item.lastSentAt),
    })),
  }
}

/**
 * Give a pending invitation a new link and a fresh lifetime, and mail it
 * again. The old link stops working at once. Resending re-issues the
 * invitation's role, so the grant rule runs again, on the actor's role as
 * re-read under lock. A resend within `INVITATION_RESEND_COOLDOWN` of the
 * last send is refused, except a staff resend (`resentFromId`), which is
 * audited with a reason; every resend spends the recipient's daily budget.
 * @param actor - The signed-in user resending it, named in the email.
 * @param tenantId - The tenant it must belong to.
 * @param invitationId - The invitation.
 * @param options - `resentFromId` when a staff resend re-runs this for an earlier message; `reason` when staff resend through platform access.
 * @throws {HttpError} 404 when the tenant is gone, before anything is written; 404 `Tenant not found` when the actor lost access; 403 when the actor is below admin; 404 `invitation_not_found` when it is not pending in this tenant; 403 when the actor may not grant its role; 429 `invitation_resend_cooldown` inside the cooldown (with `Retry-After`); 429 `RATE_LIMITED` when the address has had its day's invitation mail, or this tenant its share of it; 400 `REASON_REQUIRED` when the locked re-read finds platform access and no reason was given.
 */
export async function resend(
  actor: Actor,
  tenantId: string,
  invitationId: string,
  options: EmailResendOptions & StaffReasonOption = {}
): Promise<void> {
  // Before the write, so a vanished tenant cannot leave the old link replaced and no email sent.
  const tenant = await tenantForMessages(tenantId)
  const rawToken = generateInvitationToken()
  const invitation = await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    assertStaffReasonGiven(access, options)
    const pending = await invitationRepository.findPendingById(tenantId, invitationId, tx)
    if (!pending) throw invitationNotFound()
    if (!canActorGrantRole(actorRole, pending.role)) {
      throw new HttpError(GRANT_REFUSED_MESSAGE, 403)
    }
    // A staff resend (audited, with a reason) skips the cooldown.
    const hasCooldown = options.resentFromId === undefined
    if (hasCooldown) assertResendCooldownOver(pending)
    // The swap re-checks the cooldown: the read above took no row lock, so a concurrent resend may have landed since.
    const updated = await invitationRepository.replaceToken(
      pending.id,
      hashToken(rawToken),
      invitationExpiry(),
      tx,
      hasCooldown ? { cooldownMs: requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN) } : {}
    )
    if (!updated) {
      const stillPending = await invitationRepository.findPendingById(tenantId, invitationId, tx)
      if (hasCooldown && stillPending) {
        throw resendCooldownError(stillPending.lastSentAt)
      }
      throw invitationNotFound()
    }
    // After the token swap, so a refusal rolls it back and the mailed link keeps working.
    await assertRecipientBudget(updated.email, tenantId)
    await record(
      {
        action: 'invitation.resent',
        actor,
        access,
        tenantId,
        targetId: updated.id,
        metadata: {
          role: updated.role,
          emailDomain: auditEmailDomain(updated.email),
          ...(options.reason !== undefined && { reason: options.reason }),
        },
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
  // The email context takes only `resentFromId`: the staff reason stays in the audit entry.
  const resendOptions: EmailResendOptions =
    options.resentFromId === undefined ? {} : { resentFromId: options.resentFromId }
  // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget: the response must not wait on the queue
  dispatchInvitationMessages(context, undefined, resendOptions).catch((error: unknown) => {
    logger.error('Invitation messages failed', { error, invitationId: invitation.id })
  })
}

/**
 * Mail a staff invitee their pending invitation again, because they asked
 * Apex for a sign-in link: an Apex link reaches only staff, and an invitee is
 * not staff until they accept. Run from the sign-in request's follow-up,
 * after its reply, so nothing here is visible to the requester.
 *
 * It does nothing when the platform tenant holds no pending, unexpired
 * invitation for the address, inside `INVITATION_RESEND_COOLDOWN` of its last
 * send (re-checked by the token swap, so two concurrent requests mail once),
 * or when the address has had its day's invitation mail. Otherwise one
 * transaction gives the invitation a new link, keeping its expiry so a
 * request from anyone cannot lengthen it, stamps `last_sent_at`, spends the
 * recipient budget and audits `invitation.resent` as the system with
 * `trigger: 'sign_in_request'`; the mail is queued after commit.
 * @param email - The address that asked for a link.
 * @returns Resolves once the mail is queued or nothing is due; it never rejects, and logs its own failure.
 */
export async function resendPlatformInvitationForSignIn(email: string): Promise<void> {
  try {
    const platform = await tenantRepository.findPlatformTenant()
    if (!platform) throw new HttpError('The platform tenant is missing', 500)
    const pending = await invitationRepository.findRedeemableForEmail(platform.id, email)
    if (!pending || isInsideResendCooldown(pending)) return

    const rawToken = generateInvitationToken()
    const invitation = await db.transaction(async (tx) => {
      const updated = await invitationRepository.replaceToken(
        pending.id,
        hashToken(rawToken),
        pending.expiresAt,
        tx,
        { cooldownMs: requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN) }
      )
      // Accepted, revoked or resent since the read: nothing is due.
      if (!updated) return
      // After the token swap, so a refusal rolls it back and the mailed link keeps working.
      if ((await spendInvitationRecipientBudget(updated.email, platform.id)) === 'exhausted') {
        throw new RecipientBudgetSpentError()
      }
      await record(
        {
          action: 'invitation.resent',
          actor: 'system',
          access: 'system',
          tenantId: platform.id,
          targetId: updated.id,
          metadata: {
            role: updated.role,
            emailDomain: auditEmailDomain(updated.email),
            trigger: 'sign_in_request',
          },
        },
        tx
      )
      return updated
    })
    if (!invitation) return

    const context = {
      invitation,
      rawToken,
      tenant: { name: platform.name, slug: platform.slug, isPlatform: platform.isPlatform },
      inviterName: inviterDisplayName(
        invitation.invitedBy === null
          ? undefined
          : await userRepository.findById(invitation.invitedBy)
      ),
      invitee: await userRepository.findByEmail(invitation.email),
      // The swap kept the expiry, so the mail states the time actually left.
      expiresInDays: daysLeftUntil(invitation.expiresAt),
    }
    await dispatchInvitationMessages(context, undefined)
  } catch (error) {
    if (error instanceof RecipientBudgetSpentError) return
    logger.error('Sign-in invitation resend failed', { error: redactedForLog(error) })
  }
}

/**
 * Revoke a pending invitation. The actor's role is re-read under lock, and
 * the grant rule applies as it does to invite and resend: an admin cannot
 * revoke an owner or admin invitation it could not have sent.
 * @param actor - The signed-in user revoking it.
 * @param tenantId - The tenant it must belong to.
 * @param invitationId - The invitation.
 * @param options - `reason` when staff revoke through platform access, recorded in the audit entry.
 * @throws {HttpError} 404 `Tenant not found` when the actor lost access; 403 when the actor is below admin; 404 `invitation_not_found` when it is not pending in this tenant; 403 when the actor may not grant its role; 400 `REASON_REQUIRED` when the locked re-read finds platform access and no reason was given.
 */
export async function revoke(
  actor: Actor,
  tenantId: string,
  invitationId: string,
  options: StaffReasonOption = {}
): Promise<void> {
  await db.transaction(async (tx) => {
    const { role: actorRole, access } = await lockActorRole(actor, tenantId, 'admin', tx)
    assertStaffReasonGiven(access, options)
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
        metadata: {
          role: pending.role,
          emailDomain: auditEmailDomain(pending.email),
          ...(options.reason !== undefined && { reason: options.reason }),
        },
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
  return {
    tenant: { name: found.tenant.name, slug: found.tenant.slug },
    role: membership.role,
    alreadyMember: true,
  }
}

/**
 * Accept an invitation as the signed-in user. Only the owner of the
 * verified invited address may accept; a second accept by them succeeds.
 * A claimed accept that adds a membership emits `invitation_accepted` after
 * commit, saying whether the tenant had no member before; an accept that
 * finds the user already a member, or a repeat accept, emits nothing.
 * An owner invitation, and any platform-tenant invitation, locks the user's
 * row `FOR SHARE` before the claim (`lockUserForOwnership`), so a concurrent
 * staff delete of the user either sees the new ownership or platform role, or
 * wins and this answers 401.
 * @param rawToken - The raw token from the link.
 * @param userId - The signed-in user.
 * @returns The tenant, the role the user holds (an existing membership's role is kept), and `alreadyMember`: true for a repeat accept and for a user who was a member already.
 * @throws {HttpError} 404 `invitation_invalid`; 403 `invitation_email_mismatch` when the address differs; 403 `invitation_email_unverified` when it matches but is unverified; 401 when the account is gone or inactive.
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
    // Before the claim: a delete takes the user row, then the invitations the user sent, and this one may be among them. A platform invitation of any role makes the user staff, which the delete's rank rule must see.
    if (valid.invitation.role === 'owner' || valid.tenant.isPlatform) {
      await lockUserForOwnership(user.id, () => new HttpError('Authentication required', 401), tx)
    }

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
      alreadyMember: !inserted,
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

/**
 * Refuse a join the maintenance mode forbids: joining is a write, so both
 * `read_only` and `full` refuse it, for staff too (the route has no staff
 * pass). The route's gate refused it already; this catches a mode that
 * changed since, before anything is written.
 * @throws {MaintenanceModeError} 503 `READ_ONLY_MODE` or `MAINTENANCE_MODE`.
 */
function assertJoinAllowedByMode(): void {
  const snapshot = getMaintenanceMode()
  if (snapshot.mode === 'read_only') throw new MaintenanceModeError(READ_ONLY_MODE_CODE, snapshot)
  if (snapshot.mode === 'full') throw new MaintenanceModeError(MAINTENANCE_MODE_CODE, snapshot)
}

/**
 * The existing account an invitation link signs in, settled before the
 * verify's transaction: none when the address has no account; refused when
 * the account is inactive or `assertSignInAllowed` refuses it, both before
 * anything is written; claimed when it was never verified, as a sign-in link
 * claims one (the click proves the mailbox, so a squatter's sessions and
 * federated links go). An account deleted or deactivated during the claim is the
 * generic invalid link, never the claim's 500.
 * @param email - The invitation's stored (lowercased) address.
 * @returns The account, or undefined when the click should create one.
 * @throws {HttpError} 404 `invitation_invalid` for an inactive or vanished account.
 * @throws {MaintenanceModeError} 503 `MAINTENANCE_MODE` from `assertSignInAllowed`.
 */
async function invitedAccount(email: string): Promise<User | undefined> {
  const existing = await userRepository.findByEmail(email)
  if (existing && !existing.active) throw invitationInvalid()
  await assertSignInAllowed(existing?.id)
  if (existing?.emailVerifiedAt !== null) return existing
  let claimed: User
  try {
    claimed = await claimNeverVerifiedAccount(existing.id, clearSquatterCredentials(existing.id))
  } catch (error) {
    if (isClaimedAccountGone(error)) throw invitationInvalid()
    throw error
  }
  if (!claimed.active) throw invitationInvalid()
  return claimed
}

/**
 * Create the invitee's verified account in the verify's transaction. When
 * another write created an account for the address first (a concurrent click
 * on the same link, or a registration), the insert loses the users unique
 * index and the click answers the generic invalid link; the transaction rolls
 * back before the claim, so the link stays usable for the next click.
 * @param email - The invitation's address.
 * @param tx - The verify's transaction.
 * @returns The new account.
 * @throws {HttpError} 404 `invitation_invalid` when the address was taken meanwhile.
 */
async function createInvitedAccount(email: string, tx: DbTransaction): Promise<User> {
  try {
    return await createLinkedAccount(email, tx)
  } catch (error) {
    if (isAddressTaken(error)) throw invitationInvalid()
    throw error
  }
}

/**
 * Lock an existing invitee's row `FOR SHARE` in the verify's transaction and
 * re-check it, so a deactivation or delete that committed since the lookup
 * wins, and one that commits later waits for the join and the session and
 * then revokes them. The lock comes before the claim, as `accept`'s
 * `lockUserForOwnership` does.
 * @param userId - The invitee.
 * @param tx - The verify's transaction.
 * @returns The locked row.
 * @throws {HttpError} 404 `invitation_invalid` when the account is gone or inactive.
 */
async function lockActiveInvitee(userId: string, tx: DbTransaction): Promise<User> {
  const locked = await userRepository.lockById(userId, 'share', tx)
  if (!locked?.active) throw invitationInvalid()
  return locked
}

/**
 * Accept an invitation in one click, signed out: sign the invitee in and
 * join them. The link is single-use: once accepted it signs nobody in, the
 * invitee included (a signed-in invitee gets `alreadyMember` from `accept`).
 *
 * Order, as `verifySignInLink` checks: the link is looked up first, outside
 * any transaction, so a used, expired, revoked, suspended-tenant or
 * archived-tenant link touches no account; the maintenance mode is
 * re-checked (`assertJoinAllowedByMode`); the address's account is resolved
 * and passed through `assertSignInAllowed` (`invitedAccount`); the mode is
 * checked once more; then one
 * transaction creates the account or locks it, claims the invitation, adds
 * the membership (an existing one keeps its role), audits
 * `invitation.accepted` and issues the session. A claim that loses (the link
 * went dead since the lookup) rolls a new account back. After commit it
 * stamps `lastLoggedInAt`, best effort, and emits `invitation_accepted` when
 * it joined, `email_verified` and `user_signed_up` when it created the
 * account, and `user_signed_in`.
 * @param rawToken - The raw token from the link.
 * @returns The session, and the tenant and role it joined with.
 * @throws {HttpError} 404 `invitation_invalid`, for every link that signs nobody in.
 * @throws {MaintenanceModeError} 503 `READ_ONLY_MODE` or `MAINTENANCE_MODE` when a mode began after the route's gate.
 */
export async function verifyInvitation(rawToken: string): Promise<InvitationSession> {
  const tokenHash = hashToken(rawToken)
  const valid = await invitationRepository.findValidByTokenHash(tokenHash)
  if (!valid) throw invitationInvalid()
  assertJoinAllowedByMode()
  const account = await invitedAccount(valid.invitation.email)
  // Again after the claim's own transactions, so a mode that began meanwhile writes no join.
  assertJoinAllowedByMode()
  const isNewUser = account === undefined

  const sessionId = randomUUID()
  const outcome = await db.transaction(async (tx): Promise<VerifyOutcome> => {
    const user = account
      ? await lockActiveInvitee(account.id, tx)
      : await createInvitedAccount(valid.invitation.email, tx)
    const claimed = await invitationRepository.claimForAccept(tokenHash, user.id, tx)
    // Dead since the lookup (accepted by a concurrent click, revoked, resent, expired, tenant suspended or archived).
    if (!claimed) throw invitationInvalid()

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
    const refreshToken = await issueRefreshToken(user.id, sessionId, tx)
    const settled = { user, refreshToken, role: membership.role }
    if (!inserted) return settled
    const memberCount = await userMembershipRepository.countMemberships(claimed.tenantId, tx)
    return {
      ...settled,
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

  const user = await stampSignIn(outcome.user)
  const accessToken = signAccessToken(user, sessionId, outcome.refreshToken.authenticatedAt)
  const platformRole = await platformRoleForLogin(user.id)
  if (outcome.joined) await emitDomainEvent(outcome.joined, { access: 'member' })
  if (isNewUser) {
    await emitDomainEvent({ type: 'email_verified', userId: user.id, at: new Date() })
    await emitDomainEvent({
      type: 'user_signed_up',
      userId: user.id,
      method: 'link',
      at: user.createdAt,
    })
  }
  await emitDomainEvent({ type: 'user_signed_in', userId: user.id, method: 'link', at: new Date() })
  return {
    user,
    accessToken,
    refreshToken: outcome.refreshToken,
    platformRole,
    isNewUser,
    tenant: { name: valid.tenant.name, slug: valid.tenant.slug },
    role: outcome.role,
  }
}

/**
 * Stamp `lastLoggedInAt` on an account a verify just signed in, after the
 * join commits. Best effort: the link is spent by then, so a failed stamp is
 * logged and the session is still handed back.
 * @param user - The account as the verify's transaction left it.
 * @returns The stamped row, or the given one when the stamp failed.
 */
async function stampSignIn(user: User): Promise<User> {
  try {
    return (await userRepository.update(user.id, { lastLoggedInAt: new Date() })) ?? user
  } catch (error) {
    logger.error('Last sign-in could not be stamped', { error, userId: user.id })
    return user
  }
}
