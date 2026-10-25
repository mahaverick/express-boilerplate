/**
 * @file Staff management of users, behind `/platform/users`. The routes check
 * the caller's platform role before any of this runs.
 */
import { AUTH_PROVIDERS, type AuthProvider } from '@/constants/auth-provider.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { redactedForLog } from '@/errors/postgres-errors'
import {
  canPlatformActorModifyTarget,
  canStaffMailTarget,
  isRoleAtLeast,
} from '@/policies/tenant.policy'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { BillingRepository } from '@/repositories/billing.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import {
  PlatformUserRepository,
  type PlatformUserMembership,
  type PlatformUserPendingInvitation,
  type PlatformUserRecord,
} from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { sendPayerLeftEverywhere } from '@/services/billing/billing-emails.service'
import { withTransaction, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { assertStillPlatformRole, getPlatformMembership } from '@/services/platform.service'
import {
  denySessionsAfterCommit,
  revokeSessionRows,
  revokeSignInLinksOf,
} from '@/services/session.service'
import { sendSignInLink } from '@/services/sign-in-link.service'
import { resendAvailableAt } from '@/services/tenant-invitation.service'
import type { Actor } from '@/types/actor'
import type { EmailResendOptions } from '@/types/email-context'
import type { EmailDelivery } from '@/types/email-delivery'
import { hostnameDomain } from '@/utilities/email.utilities'
import type { ListPage } from '@/utilities/list-page.utilities'
import type {
  CreatePlatformUserInput,
  PlatformUserListQuery,
  UpdatePlatformUserInput,
} from '@/validators/platform.validators'

const platformUserRepository = new PlatformUserRepository()
const authProviderRepository = new AuthProviderRepository()
const billingRepository = new BillingRepository()
const emailMessageRepository = new EmailMessageRepository()
const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const userMembershipRepository = new UserMembershipRepository()

/**
 * One user as the staff directory returns it. `membershipCount` counts live
 * customer tenants only (archived tenants and the platform tenant are
 * excluded), whereas the detail's `memberships` list includes archived ones.
 */
export type PlatformUserRow = PlatformUserRecord

/**
 * One user with everything the staff detail page shows.
 */
export interface PlatformUserDetail extends PlatformUserRow {
  authProviders: AuthProvider[]
  memberships: PlatformUserMembership[]
  pendingInvitations: (PlatformUserPendingInvitation & { resendAvailableAt: Date | null })[]
}

/**
 * One page of the staff user list: live users, or soft-deleted ones under `status=deleted`.
 * @param query - The parsed list query.
 * @returns The page.
 * @throws {InvalidCursorError} When the cursor does not verify.
 */
export async function listUsers(query: PlatformUserListQuery): Promise<ListPage<PlatformUserRow>> {
  return platformUserRepository.list(query.params, query.filters)
}

/**
 * A user and everything the staff detail page shows. A soft-deleted user is
 * returned too, with `deletedAt` set: its page offers only a purge. Its
 * `pendingInvitations` is always empty: invitations are matched by address,
 * and a deleted user's address may belong to another account.
 * @param userId - The user's id.
 * @returns The detail.
 * @throws {HttpError} 404 when no user has that id.
 */
export async function getUserDetail(userId: string): Promise<PlatformUserDetail> {
  const record = await platformUserRepository.findRecord(userId, { includeDeleted: true })
  if (!record) throw notFoundError('user')
  const [providers, memberships, pendingInvitations] = await Promise.all([
    authProviderRepository.findByUser(userId),
    platformUserRepository.listMemberships(userId),
    record.deletedAt === null ? platformUserRepository.listPendingInvitations(record.email) : [],
  ])
  const present = new Set(providers.map((provider) => provider.provider))
  return {
    ...record,
    authProviders: AUTH_PROVIDERS.filter((provider) => present.has(provider)),
    memberships,
    pendingInvitations: pendingInvitations.map((invitation) => ({
      ...invitation,
      resendAvailableAt: resendAvailableAt(invitation.lastSentAt),
    })),
  }
}

const DUPLICATE_EMAIL_MESSAGE =
  'An account already uses that email address. Search Users to open it.'
const STAFF_TARGET_MESSAGE =
  "Your platform role can't act on this staff member. Ask a platform owner."

/**
 * The 403 for a staff member editing their own account, which no role allows.
 */
const SELF_EDIT_MESSAGE = "You can't edit your own account here. Ask another platform admin."

/**
 * The platform tenant: where every `user.*` audit entry is written.
 * @param executor - Where to read. Defaults to the pool.
 * @returns The platform tenant.
 * @throws {HttpError} 500 when the seeded row is missing.
 */
export async function platformTenantOrThrow(executor?: DbExecutor): Promise<Tenant> {
  const platform = await tenantRepository.findPlatformTenant(executor)
  if (!platform) throw new HttpError('The platform tenant is missing', 500)
  return platform
}

/**
 * The live record for a user, as the routes return it.
 * @param userId - The user's id.
 * @returns The record.
 * @throws {HttpError} 404 when the user is unknown or soft-deleted.
 */
async function requireRecord(userId: string): Promise<PlatformUserRow> {
  const found = await platformUserRepository.findRecord(userId)
  if (!found) throw notFoundError('user')
  return found
}

/**
 * Run a mail send after the write committed, reporting instead of throwing a
 * failure: the write stands whatever happens to the mail.
 * @param send - Issues the link and queues the job.
 * @param what - A label for the log line.
 * @param userId - The user the mail is for.
 * @returns Whether the mail was queued.
 */
async function trySend(
  send: () => Promise<void>,
  what: string,
  userId: string
): Promise<EmailDelivery> {
  try {
    await send()
    return { emailSent: true }
  } catch (error) {
    logger.error(`${what} failed`, { error: redactedForLog(error), userId })
    return { emailSent: false }
  }
}

/**
 * What `lockStaffPair` returns.
 */
interface LockedStaffPair {
  actorRole: MembershipRole
  target: User
  targetRole: MembershipRole | null
  platform: Tenant
}

/**
 * The actor's and the target's platform roles and the target's user row,
 * locked in the order the rest of the codebase uses: the customer tenants'
 * owner rows (tenant-id order), then the platform tenant's owner rows, then
 * the actor's and target's platform memberships, then the actor's user row
 * FOR SHARE (`assertStillPlatformRole`), then the target's user row. An actor
 * deleted or deactivated by a transaction that held these locks first is
 * seen here, after the wait, and refused. The target's platform role is read
 * after the target's user row is locked, so a platform invitation the target
 * accepted while this waited (it holds that row first) is seen.
 * Every transaction that locks membership rows in both a customer tenant and
 * the platform tenant locks the customer tenant's first
 * (tenant-access.service.ts), so the order has no cycle.
 * @param actor - The signed-in staff user.
 * @param targetUserId - The user acted on.
 * @param minimum - The platform role the route requires, re-checked under lock.
 * @param tx - The transaction holding the locks.
 * @param customerOwnerTenantIds - Customer tenants whose owner rows to lock first (the last-owner guard of a delete).
 * @returns The roles, the locked target and the platform tenant.
 * @throws {HttpError} 404 when the actor's platform role falls below `minimum` or the target is gone; 401 when the actor's own account is gone or inactive; 403 when `canPlatformActorModifyTarget` refuses a staff target.
 */
async function lockStaffPair(
  actor: Actor,
  targetUserId: string,
  minimum: MembershipRole,
  tx: DbTransaction,
  customerOwnerTenantIds: readonly string[] = []
): Promise<LockedStaffPair> {
  const ownerTenantIds = customerOwnerTenantIds.toSorted((a, b) => a.localeCompare(b))
  for (const tenantId of ownerTenantIds) {
    await userMembershipRepository.lockOwners(tenantId, 'no key update', tx)
  }
  const platform = await platformTenantOrThrow(tx)
  await userMembershipRepository.lockOwners(platform.id, 'no key update', tx)
  await userMembershipRepository.lockMemberships(
    platform.id,
    [actor.userId, targetUserId],
    'no key update',
    tx
  )
  const actorRole = await assertStillPlatformRole(actor, minimum, tx)

  const target = await userRepository.lockById(targetUserId, 'no key update', tx)
  if (!target) throw notFoundError('user')
  // Read again after the user-row wait: a platform invitation accepted meanwhile held that row first and has committed.
  const targetRole = await userMembershipRepository.findPlatformRole(targetUserId, tx)
  // The rule never covers oneself: a caller that must refuse a self-action does so before this, and one that allows it relies on this skip.
  if (
    targetRole !== null &&
    targetUserId !== actor.userId &&
    !canPlatformActorModifyTarget(actorRole, targetRole, false)
  ) {
    throw new HttpError(STAFF_TARGET_MESSAGE, 403)
  }
  return { actorRole, target, targetRole, platform }
}

/**
 * Mail-only actions need an admin actor of at least a staff target's rank
 * (`canStaffMailTarget`). Unlocked: the roles are read once, and the writes
 * that follow (the audit entry, the link) do not depend on them staying
 * unchanged.
 * @param actor - The signed-in staff user.
 * @param targetUserId - The user to mail.
 * @returns The target's platform role, or null when not staff.
 * @throws {HttpError} 404 when the actor is not a platform admin or owner; 403 when the target outranks them.
 */
async function assertMayMail(actor: Actor, targetUserId: string): Promise<MembershipRole | null> {
  const [actorRole, targetRole] = await Promise.all([
    getPlatformMembership(actor.userId),
    getPlatformMembership(targetUserId),
  ])
  if (actorRole === null || !isRoleAtLeast(actorRole, 'admin')) {
    throw notFoundError('route')
  }
  if (!canStaffMailTarget(actorRole, targetRole)) throw new HttpError(STAFF_TARGET_MESSAGE, 403)
  return targetRole
}

/**
 * The live, active user a mail action targets. A deactivated account could
 * not sign in with the link it would receive.
 * @param userId - The user's id.
 * @returns The user row.
 * @throws {HttpError} 404 when unknown or soft-deleted; 409 when deactivated.
 */
async function requireMailableUser(userId: string): Promise<User> {
  const user = await userRepository.findById(userId)
  if (!user) throw notFoundError('user')
  if (!user.active)
    throw new HttpError('This account is deactivated. Reactivate it, then try again.', 409)
  return user
}

/**
 * Create an unverified user and mail them the `welcome` message, which
 * carries a sign-in link; its first click verifies the address. The row,
 * its `email` provider row, the mail the address was sent before it had an
 * account (`adoptUnowned`) and the audit entry commit together; the mail
 * goes after commit and never undoes the create. The link opens the web
 * app: the new user holds no platform role, and the frontend is chosen from
 * that role, as for the staff-sent sign-in link.
 * @param actor - The signed-in staff admin.
 * @param input - The validated body.
 * @returns The new user and whether the mail was queued.
 * @throws {HttpError} 409 when a live account uses the address.
 */
export async function createUser(
  actor: Actor,
  input: CreatePlatformUserInput
): Promise<{ user: PlatformUserRow } & EmailDelivery> {
  const email = input.email.toLowerCase()
  if (await userRepository.findByEmail(email)) throw new HttpError(DUPLICATE_EMAIL_MESSAGE, 409)
  const platform = await platformTenantOrThrow()

  let created: User
  try {
    created = await withTransaction(async (tx) => {
      const user = await userRepository.create(
        { email, firstName: input.firstName, lastName: input.lastName },
        tx
      )
      // A soft-deleted account may still hold this address's 'email' row; release it, as register does.
      await authProviderRepository.releaseEmailOfDeletedUsers(email, tx)
      await emailMessageRepository.adoptUnowned(user.id, email, tx)
      await authProviderRepository.create(
        { userId: user.id, provider: 'email', providerId: email },
        tx
      )
      await record(
        {
          action: 'user.created',
          actor,
          access: 'platform',
          tenantId: platform.id,
          targetId: user.id,
          metadata: { emailDomain: hostnameDomain(email) ?? null },
        },
        tx
      )
      return user
    })
  } catch (error) {
    // A racing create won the unique index: the same answer as the pre-check.
    if (error instanceof HttpError && error.statusCode === 409) {
      throw new HttpError(DUPLICATE_EMAIL_MESSAGE, 409)
    }
    throw error
  }

  const delivery = await trySend(
    () =>
      sendSignInLink({ email: created.email, app: 'web', userId: created.id, reason: 'welcome' }),
    'Welcome mail',
    created.id
  )
  return { user: await requireRecord(created.id), emailSent: delivery.emailSent }
}

/**
 * Change a user's names. A staff target is protected by
 * `canPlatformActorModifyTarget` on platform roles, re-read under lock.
 * @param actor - The signed-in staff admin.
 * @param userId - The user to change.
 * @param input - The validated body; a null name clears it.
 * @returns The updated record.
 * @throws {HttpError} 404 unknown user; 403 staff target refused.
 */
export async function updateUser(
  actor: Actor,
  userId: string,
  input: UpdatePlatformUserInput
): Promise<PlatformUserRow> {
  // Editing oneself is refused whatever the role: the self-skip in lockStaffPair would otherwise allow it.
  if (userId === actor.userId) throw new HttpError(SELF_EDIT_MESSAGE, 403)
  await withTransaction(async (tx) => {
    const { target, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    const changes: { firstName?: string | null; lastName?: string | null } = {}
    if (input.firstName !== undefined) changes.firstName = input.firstName
    if (input.lastName !== undefined) changes.lastName = input.lastName
    await userRepository.update(target.id, changes, {}, tx)
    await record(
      {
        action: 'user.updated',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: target.id,
        metadata: { changed: Object.keys(changes) },
      },
      tx
    )
  })
  return requireRecord(userId)
}

/**
 * Mail a user a staff-sent sign-in link: the `sign_in_link` mail with the
 * sentence saying a team admin sent it. Issuing it revokes the address's
 * earlier live sign-in links. A staff target gets an Apex link; anyone else
 * a web link. The attempt is audited, with the app, before the mail.
 * @param actor - The signed-in staff admin.
 * @param userId - The user to mail.
 * @param options - `resentFromId` when a staff resend re-runs this action for an earlier message.
 * @returns Whether the mail was queued.
 * @throws {HttpError} 404 unknown user; 409 deactivated; 403 when the target outranks the actor.
 */
export async function sendSignInLinkByStaff(
  actor: Actor,
  userId: string,
  options: EmailResendOptions = {}
): Promise<EmailDelivery> {
  const target = await requireMailableUser(userId)
  const targetRole = await assertMayMail(actor, userId)
  const app: FrontendApp = targetRole === null ? 'web' : 'apex'
  const platform = await platformTenantOrThrow()

  await withTransaction(async (tx) => {
    await record(
      {
        action: 'user.sign_in_link_sent',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: userId,
        metadata: { app },
      },
      tx
    )
  })

  return trySend(
    () => sendSignInLink({ email: target.email, app, userId, reason: 'staff' }, options),
    'Staff sign-in link mail',
    userId
  )
}

/**
 * Refuse removing the platform's last active owner. Unreachable through the
 * routes' role rules (an admin is refused a staff owner by
 * `canPlatformActorModifyTarget`, and an owner acting on another owner is
 * an active owner who remains); kept as defence in depth.
 * @param targetRole - The target's platform role, or null when not staff.
 * @param otherActiveOwners - Live, active platform owners other than the target, counted under the owner lock.
 * @param verb - Which action, for the message.
 * @throws {HttpError} 409 when no other active owner would remain.
 */
export function assertPlatformOwnerRemains(
  targetRole: MembershipRole | null,
  otherActiveOwners: number,
  verb: 'deactivate' | 'delete'
): void {
  if (targetRole === 'owner' && otherActiveOwners < 1) {
    throw new HttpError(
      `Make another staff member a platform owner before you ${verb} this one.`,
      409
    )
  }
}

/**
 * Revoke every pending invitation a user sent, in any tenant, and record one
 * `invitation.revoked` in each invitation's tenant, with platform access.
 * @param actor - The signed-in staff user.
 * @param inviterId - The user whose invitations go.
 * @param tx - The action's transaction.
 * @returns Resolves once every invitation is revoked and audited.
 */
async function revokeInvitationsSentBy(
  actor: Actor,
  inviterId: string,
  tx: DbTransaction
): Promise<void> {
  const revoked = await tenantInvitationRepository.revokePendingByInviter(inviterId, tx)
  for (const invitation of revoked) {
    await record(
      {
        action: 'invitation.revoked',
        actor,
        access: 'platform',
        tenantId: invitation.tenantId,
        targetId: invitation.id,
        metadata: {
          role: invitation.role,
          emailDomain: hostnameDomain(invitation.email) ?? null,
        },
      },
      tx
    )
  }
}

/**
 * Refuse an action on the actor's own account.
 * @param actor - The signed-in staff user.
 * @param userId - The target.
 * @param message - The 409 message.
 * @throws {HttpError} 409 when they are the same user.
 */
function refuseSelf(actor: Actor, userId: string, message: string): void {
  if (actor.userId === userId) throw new HttpError(message, 409)
}

/**
 * Deactivate a user: `active = false`, every token row, every live sign-in
 * link mailed to their address and every pending invitation they sent
 * revoked in the same transaction, the revoked
 * sessions denied after commit. A racing login either committed first and
 * loses its session here, or waits on the user row lock (its FOR SHARE
 * re-read conflicts with this FOR NO KEY UPDATE) and sees the inactive account.
 * @param actor - The signed-in staff admin, recently authenticated.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns The updated record.
 * @throws {HttpError} 409 self, already inactive, or the last active platform owner; 403 staff target refused; 404 unknown.
 */
export async function deactivateUser(
  actor: Actor,
  userId: string,
  reason: string
): Promise<PlatformUserRow> {
  refuseSelf(actor, userId, "You can't deactivate your own account. Ask another platform admin.")
  const revoked = await withTransaction(async (tx) => {
    const { target, targetRole, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    if (!target.active)
      throw new HttpError(
        'This user is already deactivated. Refresh the page to see their status.',
        409
      )
    assertPlatformOwnerRemains(
      targetRole,
      await userMembershipRepository.countActiveOwners(platform.id, tx, target.id),
      'deactivate'
    )
    await userRepository.update(target.id, { active: false }, {}, tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
    await revokeSignInLinksOf(target.email, tx)
    // Invitations they sent would still admit people on their authority.
    await revokeInvitationsSentBy(actor, target.id, tx)
    await record(
      {
        action: 'user.deactivated',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: target.id,
        metadata: { reason },
      },
      tx
    )
    return sessionIds
  })
  await denySessionsAfterCommit(userId, revoked)
  return requireRecord(userId)
}

/**
 * Reactivate a user. Sessions ended by the deactivation stay ended.
 * @param actor - The signed-in staff admin.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns The updated record.
 * @throws {HttpError} 409 already active; 403 staff target refused; 404 unknown.
 */
export async function reactivateUser(
  actor: Actor,
  userId: string,
  reason: string
): Promise<PlatformUserRow> {
  await withTransaction(async (tx) => {
    const { target, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    if (target.active)
      throw new HttpError('This user is already active. Refresh the page to see their status.', 409)
    await userRepository.update(target.id, { active: true }, {}, tx)
    await record(
      {
        action: 'user.reactivated',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: target.id,
        metadata: { reason },
      },
      tx
    )
  })
  return requireRecord(userId)
}

/**
 * End every session a user has, everywhere, and revoke the live sign-in
 * links mailed to their address, which would start a new one.
 * @param actor - The signed-in staff admin.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the sessions are revoked and (best-effort) denied.
 * @throws {HttpError} 409 self; 403 staff target refused; 404 unknown.
 */
export async function signOutUser(actor: Actor, userId: string, reason: string): Promise<void> {
  refuseSelf(
    actor,
    userId,
    "You can't sign yourself out here. Use Sign out on your profile instead."
  )
  const revoked = await withTransaction(async (tx) => {
    const { target, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
    await revokeSignInLinksOf(target.email, tx)
    await record(
      {
        action: 'user.signed_out',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: target.id,
        metadata: { reason },
      },
      tx
    )
    return sessionIds
  })
  await denySessionsAfterCommit(userId, revoked)
}

/**
 * Soft-delete a user and end their sessions; remove their federated provider
 * links and revoke the invitations they sent, so the address can be reused
 * fully, Google included (Deactivate is the way to ban). Every workspace
 * they paid for forgets them as payer, with the billing address they gave
 * (`clearPayer`); the subscription keeps running. After the commit, the
 * remaining owners of each workspace they paid for with a live
 * subscription, and were still a member of, are told
 * (`sendPayerLeftEverywhere`). Refused while they
 * are the last live owner of any customer tenant or the last active platform
 * owner: those tenants' owner rows are locked first, in tenant-id order, then
 * the platform's (see `lockStaffPair`), and the owners re-counted under the
 * locks. The owned tenants are listed again under the locks, and a customer
 * tenant missing from the locked set answers 409. Every write that makes a
 * user an owner (`createTenant`, an owner invitation's `accept`, `changeRole`
 * to owner), and every platform invitation's `accept`, locks that user's row
 * `FOR SHARE` before its write (`lockUserForOwnership`). A grant that holds
 * the row first commits before the delete's lock: a customer tenant is found
 * by the second read (409), and a platform role by the role re-read in
 * `lockStaffPair` (403 for a rank the actor cannot act on, or the last-owner
 * 409). A grant that waits finds the user deleted.
 * @param actor - The signed-in platform admin or owner, recently authenticated.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the user is deleted and sessions (best-effort) denied.
 * @throws {HttpError} 409 self, last owner (naming the tenants), or owned tenants changed between the two reads; 403 staff target refused; 404 unknown.
 */
export async function deleteUser(actor: Actor, userId: string, reason: string): Promise<void> {
  refuseSelf(actor, userId, "You can't delete your own account. Ask another platform admin.")
  const owned = await platformUserRepository.listOwnedTenants(userId)
  const customerTenants = owned.filter((tenant) => !tenant.isPlatform)

  const deleted = await withTransaction(async (tx) => {
    const { target, targetRole, platform } = await lockStaffPair(
      actor,
      userId,
      'admin',
      tx,
      customerTenants.map((tenant) => tenant.tenantId)
    )
    const lockedIds = new Set(customerTenants.map((tenant) => tenant.tenantId))
    const ownedNow = await platformUserRepository.listOwnedTenants(userId, tx)
    if (ownedNow.some((tenant) => !tenant.isPlatform && !lockedIds.has(tenant.tenantId))) {
      throw new HttpError(
        "This user's owned tenants changed during the delete. Refresh the page, then try again.",
        409
      )
    }
    const blocking: string[] = []
    for (const tenant of customerTenants) {
      if ((await userMembershipRepository.countOwners(tenant.tenantId, tx)) <= 1) {
        blocking.push(tenant.tenantName)
      }
    }
    if (
      targetRole === 'owner' &&
      (await userMembershipRepository.countActiveOwners(platform.id, tx, target.id)) < 1
    ) {
      blocking.push(platform.name)
    }
    if (blocking.length > 0) {
      throw new HttpError(
        `This user is the last owner of ${blocking.join(', ')}. Make someone else an owner there first.`,
        409
      )
    }

    // Read before the delete: a workspace the user already left was told then.
    const memberOf = await userMembershipRepository.listTenantIdsForUser(target.id, tx)
    await userRepository.softDelete(target.id, tx)
    // After the user row, before the invitation writes: the billing row's place in the lock order.
    const paidFor = await billingRepository.clearPayer(target.id, tx)
    await billingRepository.closeAllOpenUpgradeRequestsOf(target.id, tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
    await authProviderRepository.deleteFederatedForUser(target.id, tx)
    await revokeInvitationsSentBy(actor, target.id, tx)
    await record(
      {
        action: 'user.deleted',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: target.id,
        metadata: { reason },
      },
      tx
    )
    return { sessionIds, memberOf, paidFor: paidFor.map((row) => row.tenantId) }
  })
  await denySessionsAfterCommit(userId, deleted.sessionIds)
  await sendPayerLeftEverywhere(userId, deleted.paidFor, deleted.memberOf, new Date())
}
