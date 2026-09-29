/**
 * @file Staff reads and writes over every customer tenant. The route has already checked the platform role; each write re-checks it under lock. The per-user "your tenants" list stays in tenant.service.ts.
 */
import { statesFor } from '@/constants/platform.constants'
import type { TenantLifecycleState } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import {
  PlatformTenantRepository,
  type PlatformTenantCursor,
  type PlatformTenantDetailRow,
  type PlatformTenantRow,
} from '@/repositories/platform-tenant.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import { assertStillPlatformRole } from '@/services/platform.service'
import {
  createOwnerInvitation,
  PLATFORM_OWNER_INVITATION_MESSAGE,
  sendOwnerInvitation,
} from '@/services/tenant-invitation.service'
import type { Actor } from '@/types/actor'
import type { EmailDelivery } from '@/types/email-delivery'
import { encodeCursor } from '@/utilities/cursor.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'
import type {
  CreatePlatformTenantInput,
  PlatformTenantSearchQuery,
} from '@/validators/platform.validators'

const platformTenantRepository = new PlatformTenantRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const invitationRepository = new TenantInvitationRepository()

/**
 * A page of search results and the opaque cursors either side of it.
 */
export interface PlatformTenantSearchPage {
  tenants: PlatformTenantRow[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One customer tenant, in any state, for the staff detail page.
 */
export type PlatformTenantDetail = PlatformTenantDetailRow

/**
 * An encoded cursor, or JSON null when there is none.
 * @param cursor - The keys, when rows lie that way.
 * @returns The opaque cursor, or null.
 */
function encoded(cursor: PlatformTenantCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at either end
  return cursor ? encodeCursor({ sortName: cursor.sortName, id: cursor.id }) : null
}

/**
 * Search every customer tenant by name or slug and lifecycle state, one keyset page at a time.
 * @param query - The validated query, with its cursor decoded.
 * @returns The page, and `nextCursor`/`prevCursor` (null at that end).
 */
export async function searchAll(
  query: PlatformTenantSearchQuery
): Promise<PlatformTenantSearchPage> {
  const page = await platformTenantRepository.searchAll({
    q: query.q,
    cursor: query.cursor,
    limit: query.limit,
    direction: query.direction,
    states: statesFor(query.state),
  })
  return {
    tenants: page.tenants,
    nextCursor: encoded(page.nextCursor),
    prevCursor: encoded(page.prevCursor),
  }
}

/**
 * One customer tenant in any lifecycle state.
 * @param tenantId - The tenant id.
 * @returns The detail.
 * @throws {HttpError} 404 when there is no such customer tenant (the platform tenant included).
 */
export async function getTenantDetail(tenantId: string): Promise<PlatformTenantDetail> {
  const detail = await platformTenantRepository.findDetail(tenantId)
  if (!detail) throw new HttpError('Tenant not found', 404)
  return detail
}

/**
 * Create a customer tenant with no members, and invite its owner, in one
 * transaction audited with platform access. The staff creator does not
 * join it. The email is enqueued after commit; a failure to enqueue it
 * leaves the tenant and its pending invitation in place.
 * @param actor - The staff user (platform admin or owner; the route checked).
 * @param input - The validated body.
 * @returns The new tenant's detail, and whether the email was enqueued.
 * @throws {HttpError} 409 `slug_taken` when the slug is taken; 409 `invitee_deactivated` when the owner address belongs to a deactivated account; 404 when the actor is no longer a platform admin; 401 when the actor's account is now inactive or gone.
 */
export async function createTenant(
  actor: Actor,
  input: CreatePlatformTenantInput
): Promise<{ tenant: PlatformTenantDetail } & EmailDelivery> {
  const { ownerEmail, ...columns } = input
  const { tenantId, dispatch } = await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const tenant = await tenantRepository.createWithoutOwner(columns, tx)
    await record(
      {
        action: 'tenant.created',
        actor,
        access: 'platform',
        tenantId: tenant.id,
        targetId: tenant.id,
        metadata: { name: tenant.name, slug: tenant.slug },
      },
      tx
    )
    return {
      tenantId: tenant.id,
      // eslint-disable-next-line unicorn/no-null -- no reason is asked when staff create the tenant
      dispatch: await createOwnerInvitation(actor, tenant.id, ownerEmail, null, tx),
    }
  })
  const delivery = await sendOwnerInvitation(dispatch)
  return { tenant: await getTenantDetail(tenantId), emailSent: delivery.emailSent }
}

/**
 * Invite a new owner to an active customer tenant that has no active owner,
 * revoking any pending owner invitation first. An unknown tenant and the
 * platform tenant are refused before any lock. The pending owner invitations
 * are revoked before the active owners are counted, so an old invitee's
 * accept either commits first (the revoke waits for a claim still in flight,
 * the count then sees the new owner, and the re-issue answers 409 having
 * written nothing) or finds its invitation revoked. Locks follow the
 * codebase order: the tenant's owner rows, the actor's platform membership
 * and user row, then the tenant row, then the pending owner invitations.
 * @param actor - The staff user (platform admin or owner, recently authenticated; the route checked).
 * @param tenantId - The tenant.
 * @param email - The new owner's address; a staff address is allowed.
 * @param reason - Why, for the audit log.
 * @returns Whether the email was enqueued.
 * @throws {HttpError} 404 when there is no such live tenant or the actor lost the role; 401 when the actor's account is now inactive or gone; 409 for the platform tenant, a non-active tenant, a tenant that has an active owner, a deactivated invitee account (`invitee_deactivated`), or an address that belongs to a member (`already_member`).
 */
export async function reissueOwnerInvitation(
  actor: Actor,
  tenantId: string,
  email: string,
  reason: string
): Promise<EmailDelivery> {
  const found = await tenantRepository.findById(tenantId)
  if (!found) throw new HttpError('Tenant not found', 404)
  if (found.isPlatform) throw new HttpError(PLATFORM_OWNER_INVITATION_MESSAGE, 409)
  const dispatch = await withTransaction(async (tx) => {
    await userMembershipRepository.lockOwners(tenantId, 'no key update', tx)
    await assertStillPlatformRole(actor, 'admin', tx)
    const tenant = await tenantRepository.lockById(tenantId, tx)
    if (!tenant) throw new HttpError('Tenant not found', 404)
    if (tenant.lifecycleState !== 'active') {
      throw new HttpError(`Cannot invite an owner to a ${tenant.lifecycleState} tenant.`, 409)
    }
    const revoked = await invitationRepository.revokePendingByRole(tenantId, 'owner', tx)
    for (const invitation of revoked) {
      await record(
        {
          action: 'invitation.revoked',
          actor,
          access: 'platform',
          tenantId,
          targetId: invitation.id,
          metadata: {
            role: invitation.role,
            // eslint-disable-next-line unicorn/no-null -- stored as JSON null in the audit metadata
            emailDomain: hostnameDomain(invitation.email) ?? null,
          },
        },
        tx
      )
    }
    // After the revoke (see the JSDoc); active owners only, since a deactivated owner cannot act.
    if ((await userMembershipRepository.countActiveOwners(tenantId, tx)) > 0) {
      throw new HttpError('This tenant already has an owner; manage it from Members.', 409)
    }
    return createOwnerInvitation(actor, tenantId, email, reason, tx)
  })
  return sendOwnerInvitation(dispatch)
}

/**
 * Error code: the tenant is not in a state the transition starts from.
 */
export const TENANT_STATE_CONFLICT_CODE = 'tenant_state_conflict'

type LifecycleAction = 'tenant.suspended' | 'tenant.reactivated' | 'tenant.archived'

/**
 * Apply one lifecycle transition, audit it, and return the tenant as it now is.
 * @param actor - The staff user.
 * @param tenantId - The tenant.
 * @param from - The states the transition starts from.
 * @param to - The new state.
 * @param action - The audit action.
 * @param reason - The staff-given reason, stored in the audit entry.
 * @returns The tenant's detail after the change.
 * @throws {HttpError} 401 when the actor's account is gone; 404 when no tenant has this id or the actor lost the platform role; 409 `tenant_state_conflict` for the platform tenant or a tenant not in `from`.
 */
async function transition(
  actor: Actor,
  tenantId: string,
  from: readonly TenantLifecycleState[],
  to: TenantLifecycleState,
  action: LifecycleAction,
  reason: string
): Promise<PlatformTenantDetail> {
  await withTransaction(async (tx) => {
    await assertStillPlatformRole(actor, 'admin', tx)
    const updated = await tenantRepository.transitionLifecycle(tenantId, from, to, tx)
    if (!updated) {
      const current = await tenantRepository.findByIdIncludingDeleted(tenantId, tx)
      if (!current) throw new HttpError('Tenant not found', 404)
      const message = current.isPlatform
        ? 'The platform tenant cannot be suspended, reactivated or archived.'
        : `This tenant is ${current.lifecycleState}.`
      throw new HttpError(message, 409, TENANT_STATE_CONFLICT_CODE)
    }
    if (to === 'archived') await invitationRepository.revokeAllPending(tenantId, tx)
    await record(
      { action, actor, access: 'platform', tenantId, targetId: tenantId, metadata: { reason } },
      tx
    )
  })
  return getTenantDetail(tenantId)
}

/**
 * Suspend an active customer tenant: its members get 404 on their next request.
 * @param actor - The staff user.
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns The tenant's detail.
 * @throws {HttpError} 404 unknown; 409 platform tenant or not active.
 */
export function suspendTenant(
  actor: Actor,
  tenantId: string,
  reason: string
): Promise<PlatformTenantDetail> {
  return transition(actor, tenantId, ['active'], 'suspended', 'tenant.suspended', reason)
}

/**
 * Reactivate a suspended customer tenant. Archived is terminal.
 * @param actor - The staff user.
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns The tenant's detail.
 * @throws {HttpError} 404 unknown; 409 platform tenant or not suspended.
 */
export function reactivateTenant(
  actor: Actor,
  tenantId: string,
  reason: string
): Promise<PlatformTenantDetail> {
  return transition(actor, tenantId, ['suspended'], 'active', 'tenant.reactivated', reason)
}

/**
 * Archive an active or suspended customer tenant: soft-delete it, revoke
 * its pending invitations and free its slug. Terminal: no transition leaves
 * `archived`.
 * @param actor - The staff user (platform admin or owner, recently authenticated; the route checked).
 * @param tenantId - The tenant.
 * @param reason - Why, for the audit log.
 * @returns The tenant's detail.
 * @throws {HttpError} 404 unknown; 409 platform tenant or already archived.
 */
export function archiveTenant(
  actor: Actor,
  tenantId: string,
  reason: string
): Promise<PlatformTenantDetail> {
  return transition(actor, tenantId, ['active', 'suspended'], 'archived', 'tenant.archived', reason)
}
