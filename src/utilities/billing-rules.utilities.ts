/**
 * @file Pure billing rules: the state a workspace is treated as being in,
 * the plan that state maps to, and how plan values and grants combine into
 * entitlements. No I/O.
 */
import {
  CANCEL_BUFFER_DAYS,
  type BillingProvider,
  type BillingProviderMode,
  type BillingState,
  type PlanKey,
} from '@/constants/billing.constants'
import {
  ENTITLEMENTS,
  type EntitlementDefinition,
  type EntitlementKey,
  type EntitlementValue,
} from '@/constants/entitlements.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type {
  BillingGraceInput,
  BillingStateInput,
  EntitlementGrantInput,
  LimitUsage,
} from '@/types/billing'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Adds whole days to a date.
 * @param date - The start.
 * @param days - Days to add.
 * @returns A new date.
 */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/**
 * When the grace window after a halt or pause ends.
 * @param row - The record's halt and pause stamps.
 * @param graceDays - Days of grace.
 * @returns The end of grace, or null when neither stamp is set.
 */
export function graceEndsAt(row: BillingGraceInput, graceDays: number): Date | null {
  const since = row.haltedAt ?? row.pausedAt
  return since ? addDays(since, graceDays) : null
}

/**
 * The state to act on. It fails closed: access never outlives payment because
 * a job or webhook ran late.
 * @param row - The stored billing fields.
 * @param now - The current time.
 * @param graceDays - Days of grace after a halt or pause.
 * @returns The stored state, or `free` when the paid window has passed.
 */
export function effectiveBillingState(
  row: BillingStateInput,
  now: Date,
  graceDays: number
): BillingState {
  const { state } = row
  if (state === 'trialing') {
    return row.trialEndsAt && now > row.trialEndsAt ? 'free' : state
  }
  if (state === 'active') {
    if (!row.currentPeriodEnd) return state
    const buffered = addDays(row.currentPeriodEnd, CANCEL_BUFFER_DAYS)
    if (row.cancelAtPeriodEnd) return now > buffered ? 'free' : state
    return now > addDays(buffered, graceDays) ? 'free' : state
  }
  if (state === 'past_due') {
    const end = graceEndsAt(row, graceDays)
    return end && now > end ? 'free' : state
  }
  return state
}

/**
 * The plan a state is served from.
 * @param state - An effective state.
 * @returns `free` for `free`, `paid` otherwise.
 */
export function planKeyForState(state: BillingState): PlanKey {
  return state === 'free' ? 'free' : 'paid'
}

/**
 * Combines a plan's values with active grants.
 * @param planKey - The plan whose registry defaults fill missing keys.
 * @param planValues - The plan's stored values by key.
 * @param grants - Grants for the workspace.
 * @param now - The current time.
 * @returns Every registry key's value and whether it came from the plan or a grant.
 */
export function mergeEntitlements(
  planKey: PlanKey,
  planValues: Record<string, EntitlementValue>,
  grants: ReadonlyArray<EntitlementGrantInput>,
  now: Date
): {
  values: Record<EntitlementKey, EntitlementValue>
  sources: Record<EntitlementKey, 'plan' | 'grant'>
} {
  const values = {} as Record<EntitlementKey, EntitlementValue>
  const sources = {} as Record<EntitlementKey, 'plan' | 'grant'>
  for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
    values[key] = Object.hasOwn(planValues, key)
      ? (planValues[key] as EntitlementValue)
      : (ENTITLEMENTS[key] as EntitlementDefinition).defaults[planKey]
    sources[key] = 'plan'
  }
  for (const grant of grants) {
    if (grant.revokedAt || (grant.expiresAt && grant.expiresAt <= now)) continue
    if (!Object.hasOwn(ENTITLEMENTS, grant.key)) continue
    const key = grant.key as EntitlementKey
    const definition: EntitlementDefinition = ENTITLEMENTS[key]
    const current = values[key]
    if (definition.kind === 'feature') {
      if (current !== true) {
        values[key] = true
        sources[key] = 'grant'
      }
      continue
    }
    if (typeof grant.value !== 'number' && grant.value !== null) continue
    if (typeof current !== 'number' && current !== null) continue
    const next = current === null || grant.value === null ? null : Math.max(current, grant.value)
    if (next !== current) {
      values[key] = next
      sources[key] = 'grant'
    }
  }
  return { values, sources }
}

/**
 * How a count stands against its limit.
 * @param limit - The cap, or null for none.
 * @param used - The count in use.
 * @param softAt - Share of the cap where the warning starts.
 * @returns The usage with `reached` and `approaching` flags.
 */
export function limitUsage(limit: number | null, used: number, softAt = 0.8): LimitUsage {
  return {
    limit,
    used,
    approaching: limit !== null && used < limit && used >= Math.ceil(limit * softAt),
  }
}

/**
 * The trial end after an extension.
 * @param current - The present trial end, if any.
 * @param now - The current time.
 * @param days - Days to add.
 * @returns The later of now and the current end, plus the days.
 */
export function extendTrialEnd(current: Date | null, now: Date, days: number): Date {
  const base = current && current > now ? current : now
  return addDays(base, days)
}

/**
 * Whether a billing row's subscriptions live with another provider or mode
 * than the running one, whose ids that provider cannot read. An unset
 * provider or mode matches any.
 * @param row - The row's provider and mode.
 * @param running - The running provider's kind and mode.
 * @returns True when the row names a different provider or mode.
 */
export function isOtherProvider(
  row: { provider: BillingProvider | null; providerMode: BillingProviderMode | null },
  running: { kind: BillingProvider; mode: BillingProviderMode }
): boolean {
  return (
    (row.provider !== null && row.provider !== running.kind) ||
    (row.providerMode !== null && row.providerMode !== running.mode)
  )
}

/**
 * Every subscription id a billing row holds, whatever its state: the
 * current one, the checkout and the scheduled switch or resubscribe.
 * @param row - The row.
 * @returns The ids, current first.
 */
export function heldSubscriptionIds(row: {
  providerSubscriptionId: string | null
  pendingSubscriptionId: string | null
  nextSubscriptionId: string | null
}): string[] {
  return [row.providerSubscriptionId, row.pendingSubscriptionId, row.nextSubscriptionId].filter(
    (id) => id !== null
  )
}

/**
 * Whether a row's period end is no later than its last sync. That holds for
 * a stand-in, which an adoption of an active subscription whose cycle was
 * not paid yet stores as the sync's own time (and that sync's `syncedAt`),
 * and also for a real period end that has lapsed by a later sync. A paid
 * period end still ahead lies after the sync that wrote it. A caller that
 * means "a stand-in" checks the period end is still ahead too.
 * @param row - The row.
 * @returns True when the period end is no later than the last sync.
 */
export function isPeriodEndAtOrBeforeSync(row: {
  currentPeriodEnd: Date | null
  syncedAt: Date | null
}): boolean {
  return (
    row.currentPeriodEnd !== null &&
    row.syncedAt !== null &&
    row.currentPeriodEnd.getTime() <= row.syncedAt.getTime()
  )
}

/**
 * How long a cancel marker counts: past the provider call and its webhook's
 * arrival.
 */
const CANCEL_MARKER_MS = 15 * 60 * 1000

/**
 * Who asked for a cancel on record: an owner (their id, null once their
 * account is gone), or staff, who are never named.
 */
export type CancelMarker = { by: 'owner'; userId: string | null } | { by: 'staff' }

/**
 * The cancel of a row's current subscription on record, and who asked for
 * it: the marker an owner's or a staff cancel wrote on the row before it
 * called the provider, while it names that subscription and is recent.
 * @param row - The row, as it stood before the change being reported.
 * @param now - The current time.
 * @returns The marker, or null when none stands.
 */
export function cancelMarkerOf(
  row: Pick<
    TenantBillingRecord,
    | 'providerSubscriptionId'
    | 'cancelMarkerSubscriptionId'
    | 'cancelMarkerBy'
    | 'cancelMarkerUserId'
    | 'cancelMarkerAt'
  >,
  now: Date
): CancelMarker | null {
  if (
    row.cancelMarkerSubscriptionId === null ||
    row.cancelMarkerSubscriptionId !== row.providerSubscriptionId ||
    row.cancelMarkerAt === null ||
    now.getTime() - row.cancelMarkerAt.getTime() > CANCEL_MARKER_MS
  ) {
    return null
  }
  if (row.cancelMarkerBy === 'staff') return { by: 'staff' }
  if (row.cancelMarkerBy === 'owner') return { by: 'owner', userId: row.cancelMarkerUserId }
  return null
}

/**
 * The date an active subscription renews, when the row knows a real one: a
 * period end still ahead, not a stand-in (no later than the last sync), and
 * not a deferred start's first charge (no later than the trial end).
 * @param row - The row.
 * @param now - The current time.
 * @returns The renewal date, or null when none can be stated.
 */
export function upcomingRenewalAt(
  row: Pick<TenantBillingRecord, 'currentPeriodEnd' | 'syncedAt' | 'trialEndsAt'>,
  now: Date
): Date | null {
  const end = row.currentPeriodEnd
  if (end === null || end <= now || isPeriodEndAtOrBeforeSync(row)) return null
  if (row.trialEndsAt !== null && end <= row.trialEndsAt) return null
  return end
}
