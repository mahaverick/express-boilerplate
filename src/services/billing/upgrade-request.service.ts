/**
 * @file A member's request that an owner upgrade the workspace, the owners'
 * list of open requests, and a member's banner dismissal.
 *
 * A request locks the requester's membership first, then the billing row, in
 * the documented lock order, so a removal that holds the membership finishes
 * first and the request then finds no member: no request outlives its
 * requester's membership. Owners are refused (they upgrade themselves), as
 * are staff acting through platform access and a workspace already paying.
 * A request while one is open returns that one. Only the first opening
 * tells the owners and sends the analytics event, after the commit.
 */
import {
  ALREADY_PAID_CODE,
  ALREADY_PAID_MESSAGE,
  UPGRADE_REQUEST_EXPIRY_DAYS,
  UPGRADE_REQUEST_MEMBERS_ONLY_MESSAGE,
  UPGRADE_REQUEST_OWNER_MESSAGE,
  UPGRADE_REQUESTS_OWNER_ONLY_MESSAGE,
  type UpgradeSurface,
} from '@/constants/billing.constants'
import type { EntitlementKey } from '@/constants/entitlements.constants'
import type { UpgradeRequest } from '@/database/models/billing.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { displayName } from '@/presenters/billing.presenter'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { trackUpgradeRequested } from '@/services/billing/billing-analytics.service'
import { sendUpgradeRequested } from '@/services/billing/billing-emails.service'
import { lockBilling } from '@/services/billing/trial.service'
import { withTransaction } from '@/services/database.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'

const billingRepository = new BillingRepository()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a member asks for.
 */
interface UpgradeRequestInput {
  /**
   * The limit or feature the member hit, if any.
   */
  key?: EntitlementKey | undefined
  surface: UpgradeSurface
}

/**
 * The answer to a request.
 */
interface UpgradeRequestResult {
  id: string
  createdAt: Date
  alreadyRequested: boolean
}

/**
 * One open request as an owner sees it: no address.
 */
interface UpgradeRequestView {
  id: string
  requestedBy: { userId: string; name: string }
  key: string | null
  createdAt: Date
}

/**
 * Refuse the platform workspace, which has no billing.
 * @param tenantId - The workspace.
 * @throws {HttpError} The unknown-route 404 for the platform workspace.
 */
async function assertCustomerTenant(tenantId: string): Promise<void> {
  const tenant = await tenantRepository.findById(tenantId)
  if (tenant === undefined) throw notFoundError('tenant')
  if (tenant.isPlatform) throw notFoundError('route')
}

/**
 * Open a member's request that an owner upgrade the workspace, or return the
 * one they already have open. The first opening tells the active owners and
 * sends `upgrade_requested`, after the commit.
 * @param actor - The signed-in member.
 * @param tenantId - The workspace.
 * @param input - The key the member hit and where they asked.
 * @returns The request, and whether it was already open.
 * @throws {HttpError} 404 when the actor lost access; 403 for an owner or through platform access; 409 `ALREADY_PAID` on a workspace paying for Paid.
 */
export async function requestUpgrade(
  actor: Actor,
  tenantId: string,
  input: UpgradeRequestInput
): Promise<UpgradeRequestResult> {
  await assertCustomerTenant(tenantId)
  const { request, alreadyRequested } = await withTransaction(async (tx) => {
    const { role, access } = await lockActorRole(actor, tenantId, 'viewer', tx)
    if (access !== 'member') throw new HttpError(UPGRADE_REQUEST_MEMBERS_ONLY_MESSAGE, 403)
    if (role === 'owner') throw new HttpError(UPGRADE_REQUEST_OWNER_MESSAGE, 403)
    const billing = await lockBilling(tenantId, tx)
    // A cancelling subscription still asks an owner to keep Paid, so only a renewing one refuses.
    if (billing.state === 'active' && !billing.cancelAtPeriodEnd) {
      throw new HttpError(ALREADY_PAID_MESSAGE, 409, ALREADY_PAID_CODE)
    }
    return billingRepository.openUpgradeRequest(
      {
        tenantId,
        requestedBy: actor.userId,
        entitlementKey: input.key ?? null,
        surface: input.surface,
        expiresAt: new Date(Date.now() + UPGRADE_REQUEST_EXPIRY_DAYS * DAY_MS),
      },
      tx
    )
  })
  if (!alreadyRequested) {
    await sendUpgradeRequested(request)
    await trackUpgradeRequested(request)
  }
  return { id: request.id, createdAt: request.createdAt, alreadyRequested }
}

/**
 * Whether the actor is an owner of the workspace by membership. Read without
 * a lock: it decides only what a read shows.
 * @param actor - The signed-in user.
 * @param tenantId - The workspace.
 * @returns True for a member owner.
 */
async function isMemberOwner(actor: Actor, tenantId: string): Promise<boolean> {
  const membership = await membershipRepository.findByUserAndTenant(actor.userId, tenantId)
  return membership?.role === 'owner'
}

/**
 * The workspace's open requests, oldest first, for an owner by membership.
 * A request whose requester's account was deleted is left out; no address
 * is shown.
 * @param actor - The signed-in owner.
 * @param tenantId - The workspace.
 * @returns The requests.
 * @throws {HttpError} 403 for anyone but a member owner.
 */
export async function listUpgradeRequests(
  actor: Actor,
  tenantId: string
): Promise<UpgradeRequestView[]> {
  if (!(await isMemberOwner(actor, tenantId))) {
    throw new HttpError(UPGRADE_REQUESTS_OWNER_ONLY_MESSAGE, 403)
  }
  const requests = await billingRepository.listOpenUpgradeRequests(tenantId)
  // One read for every requester; a deleted account is left out of it.
  const users = await userRepository.findManyByIds([
    ...new Set(requests.map((request) => request.requestedBy)),
  ])
  const byId = new Map(users.map((user) => [user.id, user]))
  return requests.flatMap((request) => {
    const user = byId.get(request.requestedBy)
    return user === undefined ? [] : [viewOf(request, user)]
  })
}

/**
 * One request as an owner sees it.
 * @param request - The request.
 * @param user - The requester's account.
 * @returns The view.
 */
function viewOf(request: UpgradeRequest, user: User): UpgradeRequestView {
  return {
    id: request.id,
    requestedBy: { userId: user.id, name: displayName(user) },
    key: request.entitlementKey,
    createdAt: request.createdAt,
  }
}

/**
 * Stop showing a banner to the member in this workspace. Idempotent. The
 * route admits members only.
 * @param actor - The signed-in member.
 * @param tenantId - The workspace.
 * @param banner - The banner.
 * @throws {HttpError} 404 when the actor is no longer a member.
 */
export async function dismissBanner(actor: Actor, tenantId: string, banner: string): Promise<void> {
  await withTransaction(async (tx) => {
    const { access } = await lockActorRole(actor, tenantId, 'viewer', tx)
    if (access !== 'member') throw notFoundError('tenant')
    await billingRepository.dismissBanner(actor.userId, tenantId, banner, tx)
  })
}
