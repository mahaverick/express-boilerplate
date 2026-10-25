/**
 * @file Seats on the members limit. A seat is a distinct address among a
 * workspace's members whose account is not soft-deleted and its pending,
 * unexpired invitations. Every write that adds a seat (an invite, the resend
 * of an expired invitation, an accept, an invitation verify or confirm) first
 * takes the seat lock, the workspace's billing row `FOR NO KEY UPDATE`, so two
 * of them at once queue and never both take the last seat. Its place in the
 * lock order is in ARCHITECTURE.md: after the user row, the owner rows, the
 * memberships and the platform-role row; before any invitation or
 * membership-row write and before the tenant or settings row.
 */
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { lockBilling } from '@/services/billing/trial.service'
import type { DbExecutor, DbTransaction } from '@/services/database.service'

const invitationRepository = new TenantInvitationRepository()

/**
 * The workspace fields the seat lock reads: the platform tenant has no
 * billing row and no members limit.
 */
export interface SeatTenant {
  /**
   * The workspace id.
   */
  id: string
  /**
   * Whether it is the platform tenant.
   */
  isPlatform: boolean
}

/**
 * Take the seat lock. A customer workspace with no billing row is repaired
 * with a Free row (`lockBilling`), never skipped.
 * @param tenant - The workspace.
 * @param tx - The transaction that adds the seat.
 * @returns The locked billing row, or undefined for the platform tenant, which takes no lock.
 */
export async function lockSeats(
  tenant: SeatTenant,
  tx: DbTransaction
): Promise<TenantBillingRecord | undefined> {
  if (tenant.isPlatform) return undefined
  return lockBilling(tenant.id, tx)
}

/**
 * How many seats a workspace has in use.
 * @param tenantId - The workspace.
 * @param executor - Where to read; the seat lock's transaction when the count decides a write.
 * @returns The number of distinct addresses holding a seat.
 */
export function countSeats(tenantId: string, executor: DbExecutor): Promise<number> {
  return invitationRepository.countSeats(tenantId, executor)
}

/**
 * Whether an address already holds a seat through a pending, unexpired
 * invitation, so inviting it again adds none.
 * @param tenantId - The workspace.
 * @param email - The address, in any case.
 * @param executor - Where to read.
 * @returns True when it does.
 */
export async function hasInvitationSeat(
  tenantId: string,
  email: string,
  executor: DbExecutor
): Promise<boolean> {
  return (
    (await invitationRepository.findRedeemableForEmail(tenantId, email, executor)) !== undefined
  )
}
