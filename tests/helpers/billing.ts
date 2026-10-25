/**
 * @file Billing fixtures for tests that need a workspace past the Free
 * plan's three members.
 */
import { tenantEntitlementGrantModel } from '@/database/models/billing.model'
import { PlanRepository } from '@/repositories/plan.repository'
import { db, sql } from '@/services/database.service'

const planRepository = new PlanRepository()

/**
 * Put a workspace on the Paid plan in the `active` state, so it has no member cap.
 * @param tenantId - The workspace.
 * @throws {Error} When the Paid plan is missing.
 */
export async function putTenantOnPaid(tenantId: string): Promise<void> {
  const paid = await planRepository.findPlanByKey('paid')
  if (!paid) throw new Error('setup: migration 0033 seeds the paid plan')
  await sql`update tenant_billing set state = 'active', plan_id = ${paid.id}, version = version + 1 where tenant_id = ${tenantId}`
}

/**
 * Grant a workspace a member cap of `n`, as staff would.
 * @param tenantId - The workspace.
 * @param n - The cap.
 */
export async function grantSeats(tenantId: string, n: number): Promise<void> {
  await db
    .insert(tenantEntitlementGrantModel)
    .values({ tenantId, key: 'members', value: n, reason: 'Test grant' })
}
