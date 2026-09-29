/**
 * @file Staff management of users, behind `/platform/users`. The routes check
 * the caller's platform role before any of this runs.
 */
import { getEnv } from '@/configs/env.config'
import { AUTH_PROVIDERS, type AuthProvider } from '@/constants/auth-provider.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import { JobPriority } from '@/constants/queue.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { redactedForLog } from '@/errors/postgres-errors'
import { addEmailJob } from '@/jobs/email.job'
import { canPlatformActorModifyTarget, isRoleAtLeast } from '@/policies/tenant.policy'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import {
  PlatformUserRepository,
  type PlatformUserCursor,
  type PlatformUserMembership,
  type PlatformUserPendingInvitation,
  type PlatformUserRecord,
} from '@/repositories/platform-user.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { record } from '@/services/audit.service'
import { sendPasswordResetMail } from '@/services/auth.service'
import { withTransaction, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { assertStillPlatformRole, getPlatformMembership } from '@/services/platform.service'
import { denySessionsAfterCommit, issueToken, revokeSessionRows } from '@/services/session.service'
import {
  buildPasswordResetUrl,
  frontendUrl,
  MISSING_FIRST_NAME_FALLBACK,
  sendVerificationMail,
} from '@/services/verification.service'
import { ACCOUNT_SETUP_TEMPLATE_KEY } from '@/templates/email/account-setup.template'
import type { Actor } from '@/types/actor'
import type { EmailDelivery } from '@/types/email-delivery'
import { encodeCursor } from '@/utilities/cursor.utilities'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'
import type {
  CreatePlatformUserInput,
  PlatformUserSearchQuery,
  UpdatePlatformUserInput,
} from '@/validators/platform.validators'

const platformUserRepository = new PlatformUserRepository()
const authProviderRepository = new AuthProviderRepository()
const userRepository = new UserRepository()
const tenantRepository = new TenantRepository()
const tenantInvitationRepository = new TenantInvitationRepository()
const userMembershipRepository = new UserMembershipRepository()
const userTokenRepository = new UserTokenRepository()

/**
 * One user as the staff directory returns it. `membershipCount` counts live
 * customer tenants only (archived tenants and the platform tenant are
 * excluded), whereas the detail's `memberships` list includes archived ones.
 */
export type PlatformUserRow = PlatformUserRecord

/**
 * A page of users and the opaque cursors either side of it (null at each end).
 */
export interface PlatformUserPage {
  users: PlatformUserRow[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One user with everything the staff detail page shows.
 */
export interface PlatformUserDetail extends PlatformUserRow {
  hasPassword: boolean
  authProviders: AuthProvider[]
  memberships: PlatformUserMembership[]
  pendingInvitations: PlatformUserPendingInvitation[]
}

/**
 * Encode a cursor for the wire.
 * @param cursor - The decoded cursor, if any.
 * @returns The opaque string, or null at that end of the list.
 */
function encodeUserCursor(cursor: PlatformUserCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at each end of the list
  return cursor ? encodeCursor({ sortEmail: cursor.sortEmail, id: cursor.id }) : null
}

/**
 * Search users, one keyset page at a time, in either direction: live users,
 * or only soft-deleted ones under `status=deleted`.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page and both cursors.
 */
export async function searchUsers(query: PlatformUserSearchQuery): Promise<PlatformUserPage> {
  const page = await platformUserRepository.search({
    limit: query.limit,
    direction: query.direction,
    q: query.q,
    status: query.status,
    verified: query.verified,
    staff: query.staff,
    cursor: query.cursor,
  })
  return {
    users: page.users,
    nextCursor: encodeUserCursor(page.nextCursor),
    prevCursor: encodeUserCursor(page.prevCursor),
  }
}

/**
 * A user and everything the staff detail page shows. A soft-deleted user is
 * returned too, with `deletedAt` set: its page offers only a purge.
 * @param userId - The user's id.
 * @returns The detail.
 * @throws {HttpError} 404 when no user has that id.
 */
export async function getUserDetail(userId: string): Promise<PlatformUserDetail> {
  const record = await platformUserRepository.findRecord(userId, { includeDeleted: true })
  if (!record) throw new HttpError('User not found', 404)
  const [stored, providers, memberships, pendingInvitations] = await Promise.all([
    // includeDeleted: a soft-deleted user's page still says whether a password was set.
    userRepository.findById(userId, { includeDeleted: true }),
    authProviderRepository.findByUser(userId),
    platformUserRepository.listMemberships(userId),
    platformUserRepository.listPendingInvitations(record.email),
  ])
  const present = new Set(providers.map((provider) => provider.provider))
  return {
    ...record,
    hasPassword: stored?.passwordHash !== null && stored?.passwordHash !== undefined,
    authProviders: AUTH_PROVIDERS.filter((provider) => present.has(provider)),
    memberships,
    pendingInvitations,
  }
}

const DUPLICATE_EMAIL_MESSAGE = 'An account already uses that email address'
const STAFF_TARGET_MESSAGE = 'Insufficient permissions to act on this staff member'

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
  if (!found) throw new HttpError('User not found', 404)
  return found
}

/**
 * Run a mail send after the write committed, reporting instead of throwing a
 * failure: the write stands whatever happens to the mail.
 * @param send - Issues the token and queues the job.
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
 * Issue a set-password token (a `password_reset` token with
 * ACCOUNT_SETUP_TTL) and queue the `account_setup` mail. Redeeming the link
 * on /reset-password stores the password and verifies the address.
 * @param user - The account.
 * @param app - The frontend the link opens.
 * @returns Resolves once the job is queued.
 */
async function sendAccountSetupMail(user: User, app: FrontendApp): Promise<void> {
  const issued = await issueToken(
    user.id,
    'password_reset',
    requireDurationMs(getEnv().ACCOUNT_SETUP_TTL)
  )
  await addEmailJob(
    {
      to: user.email,
      templateKey: ACCOUNT_SETUP_TEMPLATE_KEY,
      variables: {
        firstName: user.firstName ?? MISSING_FIRST_NAME_FALLBACK,
        setupUrl: buildPasswordResetUrl(issued.raw, frontendUrl(app)),
        appName: getEnv().APP_NAME,
      },
    },
    user.id,
    { priority: JobPriority.high }
  )
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
 * seen here, after the wait, and refused.
 * No transaction locks the platform tenant before a customer tenant
 * (tenant-access.service.ts), so the order has no cycle.
 * @param actor - The signed-in staff user.
 * @param targetUserId - The user acted on.
 * @param minimum - The platform role the route requires, re-checked under lock.
 * @param tx - The transaction holding the locks.
 * @param customerOwnerTenantIds - Customer tenants whose owner rows to lock first (the last-owner guard of a delete).
 * @returns The roles, the locked target and the platform tenant.
 * @throws {HttpError} 404 when the actor's platform role no longer meets `minimum` or the target is gone; 401 when the actor's own account is gone or inactive; 403 when `canPlatformActorModifyTarget` refuses a staff target.
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
  const memberships = await userMembershipRepository.lockMemberships(
    platform.id,
    [actor.userId, targetUserId],
    'no key update',
    tx
  )
  const actorRole = await assertStillPlatformRole(actor, minimum, tx)

  const target = await userRepository.lockById(targetUserId, 'no key update', tx)
  if (!target) throw new HttpError('User not found', 404)
  const targetRole =
    memberships.find((membership) => membership.userId === targetUserId)?.role ??
    // eslint-disable-next-line unicorn/no-null -- a non-staff target has no platform role
    null
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
 * Mail-only actions on a staff target need an actor of at least the
 * target's rank. Unlocked: the roles are read once, and the writes that follow
 * (token revocation, the audit entry) do not depend on them staying unchanged.
 * @param actor - The signed-in staff user.
 * @param targetUserId - The user to mail.
 * @returns The target's platform role, or null when not staff.
 * @throws {HttpError} 404 when the actor is no longer staff; 403 when the target outranks them.
 */
async function assertMayMail(actor: Actor, targetUserId: string): Promise<MembershipRole | null> {
  const [actorRole, targetRole] = await Promise.all([
    getPlatformMembership(actor.userId),
    getPlatformMembership(targetUserId),
  ])
  if (actorRole === null || !isRoleAtLeast(actorRole, 'admin')) {
    throw new HttpError('Not found', 404)
  }
  if (targetRole !== null && !isRoleAtLeast(actorRole, targetRole)) {
    throw new HttpError(STAFF_TARGET_MESSAGE, 403)
  }
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
  if (!user) throw new HttpError('User not found', 404)
  if (!user.active) throw new HttpError('This account is deactivated; reactivate it first', 409)
  return user
}

/**
 * Create a passwordless, unverified user and mail them a set-password link.
 * The row, its `email` provider row and the audit entry commit together;
 * the mail goes after commit and never undoes the create.
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
          // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
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
    () => sendAccountSetupMail(created, input.app),
    'Account setup mail',
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
  if (userId === actor.userId) throw new HttpError(STAFF_TARGET_MESSAGE, 403)
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
 * Mail a set-password link (no password yet) or a reset link (has one),
 * revoking the user's earlier unredeemed links first. A staff target gets an
 * Apex link; anyone else a web link. The attempt is audited before the mail.
 * @param actor - The signed-in staff admin.
 * @param userId - The user to mail.
 * @returns Whether the mail was queued.
 * @throws {HttpError} 404 unknown user; 409 deactivated; 403 when the target outranks the actor.
 */
export async function sendPasswordSetup(actor: Actor, userId: string): Promise<EmailDelivery> {
  const target = await requireMailableUser(userId)
  const targetRole = await assertMayMail(actor, userId)
  const kind = target.passwordHash === null ? 'setup' : 'reset'
  const app: FrontendApp = targetRole === null ? 'web' : 'apex'
  const platform = await platformTenantOrThrow()

  await withTransaction(async (tx) => {
    // Purpose-scoped: revokeAllForUser would also end the user's sessions.
    await userTokenRepository.revokeAllForUserAndPurpose(userId, 'password_reset', tx)
    await record(
      {
        action: 'user.password_setup_sent',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: userId,
        metadata: { kind },
      },
      tx
    )
  })

  const delivery = await trySend(
    () =>
      kind === 'setup' ? sendAccountSetupMail(target, app) : sendPasswordResetMail(target, app),
    'Password setup mail',
    userId
  )
  return delivery
}

/**
 * Mail a fresh verification link, revoking the earlier ones first.
 * @param actor - The signed-in staff admin.
 * @param userId - The user to mail.
 * @returns Whether the mail was queued.
 * @throws {HttpError} 404 unknown user; 409 deactivated; 403 target outranks the actor; 409 already verified, or no password (a verification link needs one; send a set-password link instead).
 */
export async function resendUserVerification(actor: Actor, userId: string): Promise<EmailDelivery> {
  const target = await requireMailableUser(userId)
  const targetRole = await assertMayMail(actor, userId)
  if (target.emailVerifiedAt !== null) {
    throw new HttpError('Email address already verified', 409)
  }
  if (target.passwordHash === null) {
    throw new HttpError('This account has no password yet; send a set-password link instead', 409)
  }
  const platform = await platformTenantOrThrow()

  await withTransaction(async (tx) => {
    await userTokenRepository.revokeAllForUserAndPurpose(userId, 'email_verification', tx)
    await record(
      {
        action: 'user.verification_resent',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: userId,
        metadata: {},
      },
      tx
    )
  })

  const app: FrontendApp = targetRole === null ? 'web' : 'apex'
  const delivery = await trySend(
    () => sendVerificationMail(target, app),
    'Verification mail',
    userId
  )
  return delivery
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
    throw new HttpError(`Cannot ${verb} the last platform owner`, 409)
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
 * Deactivate a user: `active = false`, every token row revoked and every
 * pending invitation they sent revoked in the same transaction, the revoked
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
  refuseSelf(actor, userId, 'You cannot deactivate your own account')
  const revoked = await withTransaction(async (tx) => {
    const { target, targetRole, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    if (!target.active) throw new HttpError('User is already inactive', 409)
    assertPlatformOwnerRemains(
      targetRole,
      await userMembershipRepository.countActiveOwners(platform.id, tx, target.id),
      'deactivate'
    )
    await userRepository.update(target.id, { active: false }, {}, tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
    // Invitations they sent would still admit people on their authority.
    await tenantInvitationRepository.revokePendingByInviter(target.id, tx)
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
    if (target.active) throw new HttpError('User is already active', 409)
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
 * End every session a user has, everywhere.
 * @param actor - The signed-in staff admin.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the sessions are revoked and (best-effort) denied.
 * @throws {HttpError} 409 self; 403 staff target refused; 404 unknown.
 */
export async function signOutUser(actor: Actor, userId: string, reason: string): Promise<void> {
  refuseSelf(actor, userId, 'Sign out from your profile instead')
  const revoked = await withTransaction(async (tx) => {
    const { target, platform } = await lockStaffPair(actor, userId, 'admin', tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
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
 * fully, Google included (Deactivate is the way to ban). Refused while they
 * are the last live owner of any customer tenant or the last active platform
 * owner: those tenants' owner rows are locked first, in tenant-id order, then
 * the platform's (see `lockStaffPair`), and the owners re-counted under the
 * locks. A tenant the target creates after the owned-tenant read is not
 * locked; the delete then commits and `requireAuth` refuses the deleted
 * account from its next request.
 * @param actor - The signed-in platform admin or owner, recently authenticated.
 * @param userId - The user.
 * @param reason - Why, for the audit log.
 * @returns Resolves once the user is deleted and sessions (best-effort) denied.
 * @throws {HttpError} 409 self or last owner (naming the tenants); 403 staff target refused; 404 unknown.
 */
export async function deleteUser(actor: Actor, userId: string, reason: string): Promise<void> {
  refuseSelf(actor, userId, 'You cannot delete your own account')
  const owned = await platformUserRepository.listOwnedTenants(userId)
  const customerTenants = owned.filter((tenant) => !tenant.isPlatform)

  const revoked = await withTransaction(async (tx) => {
    const { target, targetRole, platform } = await lockStaffPair(
      actor,
      userId,
      'admin',
      tx,
      customerTenants.map((tenant) => tenant.tenantId)
    )
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
      throw new HttpError(`Cannot delete the last owner of: ${blocking.join(', ')}`, 409)
    }

    await userRepository.softDelete(target.id, tx)
    const sessionIds = await revokeSessionRows(target.id, {}, tx)
    await authProviderRepository.deleteFederatedForUser(target.id, tx)
    await tenantInvitationRepository.revokePendingByInviter(target.id, tx)
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
    return sessionIds
  })
  await denySessionsAfterCommit(userId, revoked)
}
