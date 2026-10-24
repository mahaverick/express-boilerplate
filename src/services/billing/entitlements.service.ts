/**
 * @file A workspace's effective entitlements, and the limit check a write
 * runs under the seat lock. The effective state comes from the billing row
 * and the clock, failing closed: a trial or paid period that has ended reads
 * Free before any job catches up. Grants raise the plan's values. Whether a
 * workspace is the platform tenant is read from the tenant row, never from a
 * missing billing row: the platform tenant gets every feature and no limit,
 * and a customer workspace with no row is logged and served Free.
 */
import {
  PLAN_LIMIT_REACHED_CODE,
  type BillingState,
  type PlanKey,
} from '@/constants/billing.constants'
import {
  ENTITLEMENTS,
  type EntitlementDefinition,
  type EntitlementKey,
  type LimitKey,
} from '@/constants/entitlements.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { HttpError } from '@/errors/http-error'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { countSeats } from '@/services/billing/seats.service'
import { db, type DbExecutor, type DbTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import type { LimitUsage, PastDue, SourcedEntitlements } from '@/types/billing'
import {
  effectiveBillingState,
  graceEndsAt,
  limitUsage,
  mergeEntitlements,
  planKeyForState,
} from '@/utilities/billing-rules.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()

/**
 * What an invitee whose join a full workspace refuses reads. It carries no
 * count: the invitee is not a member, so the workspace's usage stays private.
 */
const WORKSPACE_FULL_MESSAGE =
  'This workspace is full on its current plan. Ask an owner to upgrade.'

/**
 * How each limit counts what is in use. A new limit key fails to compile
 * until it has a counter here.
 */
const LIMIT_COUNTERS: Record<
  LimitKey,
  (tenantId: string, executor: DbExecutor) => Promise<number>
> = {
  members: countSeats,
}

/**
 * What a passed limit check read under the seat lock.
 */
export interface LimitCheck {
  /**
   * The use before the write.
   */
  used: number
  limit: number
  plan: PlanKey
  state: BillingState
}

/**
 * Who a limit refusal answers: a `member` sees the count and the cap in
 * `details`; an `outsider`, an invitee whose join was refused, sees neither.
 */
type LimitAudience = 'member' | 'outsider'

/**
 * A seeded plan's display name.
 * @param key - The plan.
 * @param executor - Where to read.
 * @returns The plan row.
 * @throws {HttpError} 500 when the seeded plan is missing.
 */
async function seededPlan(key: PlanKey, executor: DbExecutor) {
  const plan = await planRepository.findPlanByKey(key, executor)
  if (plan === undefined) throw new HttpError(`The ${key} plan is missing`, 500)
  return plan
}

/**
 * Every limit's use, from the merged values.
 * @param tenantId - The workspace.
 * @param values - The merged values, or null for the platform tenant's "no limit".
 * @param executor - Where to read.
 * @returns Each limit key with its cap and use.
 */
async function limitsOf(
  tenantId: string,
  values: Record<EntitlementKey, unknown> | null,
  executor: DbExecutor
): Promise<Record<string, LimitUsage>> {
  const limits: Record<string, LimitUsage> = {}
  for (const key of Object.keys(LIMIT_COUNTERS) as LimitKey[]) {
    const value = values === null ? null : values[key]
    const definition: EntitlementDefinition = ENTITLEMENTS[key]
    limits[key] = limitUsage(
      typeof value === 'number' ? value : null,
      await LIMIT_COUNTERS[key](tenantId, executor),
      definition.softAt
    )
  }
  return limits
}

/**
 * The platform tenant's entitlements: every feature, no limit.
 * @param tenantId - The platform tenant.
 * @param executor - Where to read.
 * @returns Its entitlements, served from the Paid plan's name.
 */
async function platformEntitlements(
  tenantId: string,
  executor: DbExecutor
): Promise<SourcedEntitlements> {
  const plan = await seededPlan('paid', executor)
  const features: Record<string, boolean> = {}
  const sources = {} as Record<EntitlementKey, 'plan' | 'grant'>
  for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
    sources[key] = 'plan'
    if (ENTITLEMENTS[key].kind === 'feature') features[key] = true
  }
  return {
    plan: { key: plan.key, name: plan.name },
    state: 'active',
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDue: null,
    features,
    limits: await limitsOf(tenantId, null, executor),
    sources,
  }
}

/**
 * The failed payment of a past-due workspace.
 * @param row - The billing row.
 * @param graceDays - Days of grace after a halt or pause.
 * @returns The failed payment, or null when the row has no failure date.
 */
function pastDueOf(row: TenantBillingRecord, graceDays: number): PastDue | null {
  if (row.pastDueSince === null) return null
  return {
    since: row.pastDueSince,
    graceEndsAt: graceEndsAt(row, graceDays),
    paused: row.pausedAt !== null,
  }
}

/**
 * A workspace's effective entitlements: the plan its effective state maps
 * to, raised by its active grants, with each limit's use.
 * @param tenantId - The workspace.
 * @param executor - Where to read: the seat lock's transaction when the answer decides a write.
 * @param now - The current time.
 * @returns The entitlements and where each value came from.
 * @throws {HttpError} 500 when a seeded plan is missing.
 */
export async function getEffectiveEntitlements(
  tenantId: string,
  executor: DbExecutor = db,
  now = new Date()
): Promise<SourcedEntitlements> {
  const row = await billingRepository.findByTenantId(tenantId, executor)
  if (row === undefined) {
    const tenant = await tenantRepository.findByIdIncludingDeleted(tenantId, executor)
    if (tenant?.isPlatform === true) return platformEntitlements(tenantId, executor)
    logger.error('A customer workspace has no billing row; serving it Free', { tenantId })
  }
  const settings = await planRepository.getSettings(executor)
  const state = row ? effectiveBillingState(row, now, settings.pastDueGraceDays) : 'free'
  const planKey = planKeyForState(state)
  const plan = await seededPlan(planKey, executor)
  const grants = await planRepository.listActiveGrants(tenantId, executor)
  const merged = mergeEntitlements(planKey, plan.entitlements, grants, now)
  const features: Record<string, boolean> = {}
  for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
    if (ENTITLEMENTS[key].kind === 'feature') features[key] = merged.values[key] === true
  }
  return {
    plan: { key: plan.key, name: plan.name },
    state,
    trialEndsAt: row?.trialEndsAt ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    pastDue: row && state === 'past_due' ? pastDueOf(row, settings.pastDueGraceDays) : null,
    features,
    limits: await limitsOf(tenantId, merged.values, executor),
    sources: merged.sources,
  }
}

/**
 * Refuse a write that would take a limit past its cap. The caller must hold
 * the seat lock (`lockSeats`) in `tx`, so the count cannot change before the
 * write commits.
 * @param tenantId - The workspace.
 * @param key - The limit.
 * @param adding - How many the write adds: 0 when a seat already counted moves, as when a pending invitation becomes a member.
 * @param tx - The transaction holding the seat lock.
 * @param options - Who reads a refusal.
 * @param options.audience - `member` (the default) gets `details` with the count and cap; `outsider` gets a message with neither.
 * @returns The use before the write, the cap, and the plan and state they
 *   were read under, read under the seat lock; undefined when the limit has no cap.
 * @throws {HttpError} 402 `PLAN_LIMIT_REACHED`.
 */
export async function assertWithinLimit(
  tenantId: string,
  key: LimitKey,
  adding: number,
  tx: DbTransaction,
  options: { audience?: LimitAudience } = {}
): Promise<LimitCheck | undefined> {
  const entitlements = await getEffectiveEntitlements(tenantId, tx)
  const usage = entitlements.limits[key]
  if (usage === undefined || usage.limit === null) return undefined
  if (usage.used + adding <= usage.limit) {
    return {
      used: usage.used,
      limit: usage.limit,
      plan: entitlements.plan.key,
      state: entitlements.state,
    }
  }
  if (options.audience === 'outsider') {
    throw new HttpError(WORKSPACE_FULL_MESSAGE, 402, PLAN_LIMIT_REACHED_CODE)
  }
  const label = ENTITLEMENTS[key].label.toLowerCase()
  throw new HttpError(
    `You've used ${String(usage.used)} of ${String(usage.limit)} ${label} on ${entitlements.plan.name}. Upgrade to add more.`,
    402,
    PLAN_LIMIT_REACHED_CODE,
    undefined,
    { details: { key, used: usage.used, limit: usage.limit } }
  )
}
