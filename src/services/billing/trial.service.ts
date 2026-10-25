/**
 * @file Where a workspace's billing starts. A workspace gets a billing row when
 * it is created, and a person gets at most one trial however many workspaces
 * they create: the trial belongs to the workspace and its members share it,
 * and the per-person claim only stops trial farming. A workspace staff create
 * has no owner yet, so its trial starts when the first owner accepts.
 */
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { HttpError } from '@/errors/http-error'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import type { TenantBillingInit } from '@/repositories/tenant.repository'
import type { DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The id of a seeded plan.
 * @param key - The plan key.
 * @param tx - The open transaction.
 * @returns The plan id.
 * @throws {HttpError} 500 when the seeded plan is missing.
 */
async function planIdFor(key: 'free' | 'paid', tx: DbTransaction): Promise<string> {
  const plan = await planRepository.findPlanByKey(key, tx)
  if (plan === undefined) throw new HttpError(`The ${key} plan is missing`, 500)
  return plan.id
}

/**
 * The trial columns for a trial that starts at `now`.
 * @param trialDays - How long the trial lasts.
 * @param now - When it starts.
 * @returns The columns that put a row in the trial.
 */
function trialColumns(trialDays: number, now: Date) {
  return {
    state: 'trialing' as const,
    trialStartedAt: now,
    trialEndsAt: new Date(now.getTime() + trialDays * MS_PER_DAY),
  }
}

/**
 * The billing row a new workspace starts with. A person creating a workspace
 * gets the trial when trials are on and they have not had one: the claim
 * (`claimUserTrial`) is one atomic insert, so two workspaces created at once
 * cannot both win it. The caller records the workspace against the claim
 * (`setFirstTrialTenant`) once the workspace has an id, when the row is
 * `trialing`. Staff create a workspace with no owner, so it starts Free and,
 * when trials are on, waits for its first owner to accept.
 * @param creator - The person creating the workspace, or null for staff.
 * @param tx - The transaction that creates the workspace.
 * @param now - The current time.
 * @returns The row to insert with the workspace.
 */
export async function initialBillingFor(
  creator: { userId: string } | null,
  tx: DbTransaction,
  now = new Date()
): Promise<TenantBillingInit> {
  const settings = await planRepository.getSettings(tx)
  const freePlanId = await planIdFor('free', tx)
  if (creator === null) {
    return { state: 'free', planId: freePlanId, trialOnOwnerAccept: settings.trialEnabled }
  }
  if (!settings.trialEnabled || !(await billingRepository.claimUserTrial(creator.userId, tx))) {
    return { state: 'free', planId: freePlanId }
  }
  return { planId: await planIdFor('paid', tx), ...trialColumns(settings.trialDays, now) }
}

/**
 * Lock a customer workspace's billing row. A customer workspace with no row
 * breaks an invariant: this logs it and inserts a Free row, never a Paid one.
 * The platform workspace has no row and must not be passed.
 * @param tenantId - The customer workspace.
 * @param tx - The open transaction.
 * @returns The locked row.
 * @throws {HttpError} 500 when the row still cannot be read.
 */
export async function lockBilling(
  tenantId: string,
  tx: DbTransaction
): Promise<TenantBillingRecord> {
  const existing = await billingRepository.lockByTenantId(tenantId, tx)
  if (existing !== undefined) return existing
  logger.error('A customer workspace has no billing row; inserting a Free row', { tenantId })
  await billingRepository.insertIfAbsent(
    { tenantId, state: 'free', planId: await planIdFor('free', tx) },
    tx
  )
  const created = await billingRepository.lockByTenantId(tenantId, tx)
  if (created === undefined) throw new HttpError('The billing record is missing', 500)
  return created
}

/**
 * Start the trial of a workspace staff created, when its first owner
 * accepts. It locks the billing row, clears the wait flag so only the first
 * owner counts, and starts the trial when trials are on and this owner has
 * not had one; otherwise the workspace stays Free.
 * @param tenantId - The customer workspace.
 * @param ownerUserId - The owner who accepted.
 * @param tx - The accept's transaction.
 * @param now - The current time.
 * @returns True when a trial started.
 */
// A command that reports whether it acted; an `is` name would read as a query.
// eslint-disable-next-line unicorn/consistent-boolean-name
export async function startDeferredTrial(
  tenantId: string,
  ownerUserId: string,
  tx: DbTransaction,
  now = new Date()
): Promise<boolean> {
  const row = await lockBilling(tenantId, tx)
  if (!row.trialOnOwnerAccept) return false
  const settings = await planRepository.getSettings(tx)
  const isClaimed =
    settings.trialEnabled && (await billingRepository.claimUserTrial(ownerUserId, tx))
  const patch = isClaimed
    ? {
        trialOnOwnerAccept: false,
        planId: await planIdFor('paid', tx),
        ...trialColumns(settings.trialDays, now),
      }
    : { trialOnOwnerAccept: false }
  const updated = await billingRepository.updateVersioned(tenantId, row.version, patch, tx)
  if (updated === undefined) throw new HttpError('The billing record changed. Try again.', 409)
  if (isClaimed) await billingRepository.setFirstTrialTenant(ownerUserId, tenantId, tx)
  return isClaimed
}
