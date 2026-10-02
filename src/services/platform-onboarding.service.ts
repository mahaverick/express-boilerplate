/**
 * @file Staff onboarding reads, behind `/platform/onboarding*` and
 * `/platform/tenants/:id/onboarding`: the funnel, the per-state tenant
 * list, one tenant's onboarding, and the Overview's stuck count. The routes
 * check the caller's platform role before any of this runs. Progress is
 * derived by `platform-onboarding.repository.ts` from `ONBOARDING_STEPS`
 * and `ONBOARDING_STUCK_AFTER_DAYS`; this file shapes it. The only importer
 * of that repository.
 */
import { getEnv } from '@/configs/env.config'
import {
  ONBOARDING_STEPS,
  type OnboardingRange,
  type OnboardingState,
  type OnboardingStep,
} from '@/constants/onboarding.constants'
import type { OnboardingTenantStateFilter } from '@/constants/platform.constants'
import type { TenantLifecycleState } from '@/constants/tenant.constants'
import { HttpError } from '@/errors/http-error'
import {
  PlatformOnboardingRepository,
  type OnboardingCompletionRow,
  type OnboardingMemberRow,
  type OnboardingPageCursor,
  type OnboardingProgressOptions,
  type OnboardingProgressRow,
  type OnboardingRegistryKeys,
  type OnboardingReminderRow,
  type OnboardingUserRow,
} from '@/repositories/platform-onboarding.repository'
import type {
  OnboardingFunnel,
  OnboardingMemberStatus,
  OnboardingPerson,
  OnboardingReminderAvailability,
  OnboardingReminderBlock,
  OnboardingReminderView,
  OnboardingStepDetail,
  OnboardingStepSummary,
  OnboardingTenantPage,
  OnboardingTenantRow,
  TenantOnboardingDetail,
} from '@/types/platform-onboarding'
import { encodeCursor } from '@/utilities/cursor.utilities'
import { hostnameDomain } from '@/utilities/email.utilities'
import type { OnboardingTenantSearchQuery } from '@/validators/platform-onboarding.validators'

const platformOnboardingRepository = new PlatformOnboardingRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long after one reminder the next may go: 24 hours.
 */
export const REMINDER_INTERVAL_MS = DAY_MS

/**
 * How many reminders the tenant tab lists, newest first.
 */
export const REMINDER_HISTORY_LIMIT = 50

/**
 * The days each funnel range covers, back from the moment of the read.
 */
export const ONBOARDING_RANGE_DAYS: Readonly<Record<OnboardingRange, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

/**
 * The states a reminder may be sent in.
 */
const REMINDABLE_STATES: ReadonlySet<OnboardingState> = new Set(['in_progress', 'stuck'])

const TENANT_NOT_FOUND = 'Tenant not found'

/**
 * The registry as the repository's keys: tenant-scoped, member-scoped and required.
 * @param steps - The registry; `ONBOARDING_STEPS` unless a test passes its own.
 * @returns The keys.
 */
export function registryKeysOf(
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): OnboardingRegistryKeys {
  return {
    tenantKeys: steps.filter((step) => step.scope === 'tenant').map((step) => step.key),
    memberKeys: steps.filter((step) => step.scope === 'member').map((step) => step.key),
    requiredKeys: steps.filter((step) => step.required).map((step) => step.key),
  }
}

/**
 * The instant at or before which a tenant's last progress makes it stuck:
 * no progress for `ONBOARDING_STUCK_AFTER_DAYS` or more.
 * @param now - The current instant.
 * @param stuckAfterDays - `ONBOARDING_STUCK_AFTER_DAYS` unless a test passes its own.
 * @returns `now` minus that many days.
 */
export function stuckBeforeOf(
  now: Date,
  stuckAfterDays: number = getEnv().ONBOARDING_STUCK_AFTER_DAYS
): Date {
  return new Date(now.getTime() - stuckAfterDays * DAY_MS)
}

/**
 * The repository options for a read at `now`.
 * @param now - The current instant.
 * @returns The registry keys and the stuck cut-off.
 */
function progressOptionsAt(now: Date): OnboardingProgressOptions {
  return { keys: registryKeysOf(), stuckBefore: stuckBeforeOf(now) }
}

/**
 * The first required step, in registry order, not yet done at tenant level.
 * @param doneKeys - The steps done at tenant level.
 * @param steps - The registry; `ONBOARDING_STEPS` unless a test passes its own.
 * @returns The step, or undefined when every required step is done.
 */
export function nextRequiredStep(
  doneKeys: readonly string[],
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS
): OnboardingStep | undefined {
  return steps.find((step) => step.required && !doneKeys.includes(step.key))
}

/**
 * Whole days since the last progress, for a stuck tenant only.
 * @param state - The tenant's state.
 * @param lastProgressAt - Its last progress.
 * @param now - The current instant.
 * @returns The days, or null when the tenant is not stuck.
 */
export function daysStuckOf(
  state: OnboardingState,
  lastProgressAt: Date | null,
  now: Date
): number | null {
  // eslint-disable-next-line unicorn/no-null -- JSON null: only a stuck tenant has days stuck
  if (state !== 'stuck' || lastProgressAt === null) return null
  return Math.floor((now.getTime() - lastProgressAt.getTime()) / DAY_MS)
}

/**
 * Why a reminder cannot go now, in the order the remind endpoint checks:
 * the tenant must be active, in progress or stuck, have an active owner,
 * and have had no reminder in the last 24 hours.
 * @param input - What the rule reads.
 * @param input.lifecycleState - The tenant's lifecycle state.
 * @param input.state - Its onboarding state.
 * @param input.ownerCount - Its active owners.
 * @param input.lastSentAt - When its latest reminder went, if ever.
 * @param input.now - The current instant.
 * @returns The block, or null when a reminder may go; and when the next one may.
 */
export function reminderBlockOf(input: {
  lifecycleState: TenantLifecycleState
  state: OnboardingState
  ownerCount: number
  lastSentAt: Date | null
  now: Date
}): { blockedBy: OnboardingReminderBlock | null; nextAllowedAt: Date | null } {
  const limitEndsAt =
    input.lastSentAt === null
      ? undefined
      : new Date(input.lastSentAt.getTime() + REMINDER_INTERVAL_MS)
  const pendingUntil =
    limitEndsAt !== undefined && input.now.getTime() < limitEndsAt.getTime()
      ? limitEndsAt
      : undefined
  let blockedBy: OnboardingReminderBlock | undefined
  if (input.lifecycleState !== 'active') blockedBy = 'tenant_state_conflict'
  else if (!REMINDABLE_STATES.has(input.state)) blockedBy = 'not_in_progress'
  else if (input.ownerCount === 0) blockedBy = 'no_owner'
  else if (pendingUntil !== undefined) blockedBy = 'reminded_recently'
  return {
    // eslint-disable-next-line unicorn/no-null -- JSON null: nothing blocks it
    blockedBy: blockedBy ?? null,
    // eslint-disable-next-line unicorn/no-null -- JSON null: no limit in force
    nextAllowedAt: pendingUntil ?? null,
  }
}

/**
 * A user's display name: their first and last name, or their address when they have neither.
 * @param user - The user.
 * @returns The reference the API returns.
 */
function personOf(user: OnboardingUserRow): OnboardingPerson {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return { id: user.id, name: name === '' ? user.email : name }
}

/**
 * A step as the list and the reminder name it.
 * @param step - The step, if any.
 * @returns Its key and title, or null.
 */
function stepSummaryOf(step: OnboardingStep | undefined): OnboardingStepSummary | null {
  // eslint-disable-next-line unicorn/no-null -- JSON null: every required step is done
  return step === undefined ? null : { key: step.key, title: step.title }
}

/**
 * The deduplicated hostname domains of some addresses, in first-seen order.
 * @param emails - The addresses.
 * @returns The domains; an address with no hostname domain adds none.
 */
export function emailDomainsOf(emails: readonly string[]): string[] {
  const domains = emails
    .map((email) => hostnameDomain(email))
    .filter((domain) => domain !== undefined)
  return [...new Set(domains)]
}

/**
 * Encode a cursor for the wire.
 * @param cursor - The decoded cursor, if any.
 * @returns The opaque string, or null at that end of the list.
 */
function encodeOnboardingCursor(cursor: OnboardingPageCursor | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null at each end of the list
  return cursor ? encodeCursor({ sortAt: cursor.sortAt, id: cursor.id }) : null
}

/**
 * The funnel over the active, tracked tenants whose onboarding started in
 * the range: one entry per registry step, in registry order (a member step
 * counts a tenant once any active owner has done it), the cohort's
 * totals by state, and how many tenants are tracked at all, in or out of
 * the range.
 * @param range - The window, back from `now`.
 * @param now - The current instant; injectable for tests.
 * @returns The funnel.
 */
export async function getOnboardingFunnel(
  range: OnboardingRange,
  now: Date = new Date()
): Promise<OnboardingFunnel> {
  const from = new Date(now.getTime() - ONBOARDING_RANGE_DAYS[range] * DAY_MS)
  const [counts, trackedTenants] = await Promise.all([
    platformOnboardingRepository.funnelCounts(from, now, progressOptionsAt(now)),
    platformOnboardingRepository.countTracked(),
  ])
  const byState = new Map(counts.states.map((row) => [row.state, row.count]))
  const byStep = new Map(counts.steps.map((row) => [row.stepKey, row]))
  const totals = {
    inProgress: byState.get('in_progress') ?? 0,
    stuck: byState.get('stuck') ?? 0,
    complete: byState.get('complete') ?? 0,
    dismissed: byState.get('dismissed') ?? 0,
  }
  const started = totals.inProgress + totals.stuck + totals.complete + totals.dismissed
  return {
    range,
    from,
    totals: { started, ...totals },
    // eslint-disable-next-line unicorn/no-null -- JSON null: no tenant started in the range
    completionRate: started === 0 ? null : totals.complete / started,
    trackedTenants,
    steps: ONBOARDING_STEPS.map((step) => ({
      key: step.key,
      title: step.title,
      scope: step.scope,
      required: step.required,
      completed: byStep.get(step.key)?.completed ?? 0,
      staffCompleted: byStep.get(step.key)?.staffCompleted ?? 0,
    })),
  }
}

/**
 * One list row from its progress and the tenant's active owners.
 * @param row - The progress row.
 * @param owners - The tenant's active owners.
 * @param now - The current instant.
 * @returns The row.
 */
function toTenantRow(
  row: OnboardingProgressRow,
  owners: readonly OnboardingUserRow[],
  now: Date
): OnboardingTenantRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    state: row.state,
    owners: owners.map((owner) => personOf(owner)),
    startedAt: row.startedAt,
    lastProgressAt: row.lastProgressAt,
    completedAt: row.completedAt,
    daysStuck: daysStuckOf(row.state, row.lastProgressAt, now),
    nextStep: stepSummaryOf(nextRequiredStep(row.doneKeys)),
    requiredDone: row.requiredDone,
    requiredTotal: registryKeysOf().requiredKeys.length,
  }
}

/**
 * One page of the active, tracked tenants in one onboarding state: stuck
 * tenants longest stuck first, every other state newest first.
 * @param query - The validated query, with its cursor decoded.
 * @param now - The current instant; injectable for tests.
 * @returns The page, and `nextCursor`/`prevCursor` (null at that end).
 */
export async function searchOnboardingTenants(
  query: OnboardingTenantSearchQuery,
  now: Date = new Date()
): Promise<OnboardingTenantPage> {
  const state: OnboardingTenantStateFilter = query.state
  const page = await platformOnboardingRepository.listByState({
    ...progressOptionsAt(now),
    state,
    isAscending: state === 'stuck',
    limit: query.limit,
    direction: query.direction,
    cursor: query.cursor,
  })
  const owners = await platformOnboardingRepository.activeOwners(page.rows.map((row) => row.id))
  return {
    tenants: page.rows.map((row) =>
      toTenantRow(
        row,
        owners.filter((owner) => owner.tenantId === row.id),
        now
      )
    ),
    nextCursor: encodeOnboardingCursor(page.nextCursor),
    prevCursor: encodeOnboardingCursor(page.prevCursor),
  }
}

/**
 * How many active, tracked tenants are stuck now, for the Overview.
 * @param now - The current instant; injectable for tests.
 * @returns The count.
 */
export async function countStuckTenants(now: Date = new Date()): Promise<number> {
  return platformOnboardingRepository.countStuck(progressOptionsAt(now))
}

/**
 * One member's own completion of a member step.
 * @param member - The member.
 * @param completion - Their completion, if any.
 * @returns The status.
 */
function memberStatusOf(
  member: OnboardingMemberRow,
  completion: OnboardingCompletionRow | undefined
): OnboardingMemberStatus {
  return {
    user: personOf(member),
    role: member.role,
    // eslint-disable-next-line unicorn/no-null -- JSON null: not done
    completedAt: completion?.completedAt ?? null,
    // eslint-disable-next-line unicorn/no-null -- JSON null: not done
    source: completion?.source ?? null,
  }
}

/**
 * The completion a step counts at tenant level: its tenant row, or a member
 * step's earliest by an active owner.
 * @param step - The step.
 * @param completions - The step's stored completions, oldest first.
 * @param activeOwnerIds - The tenant's active owners.
 * @returns The completion, or undefined when the step is not done.
 */
function countedCompletionOf(
  step: OnboardingStep,
  completions: readonly OnboardingCompletionRow[],
  activeOwnerIds: ReadonlySet<string>
): OnboardingCompletionRow | undefined {
  if (step.scope === 'tenant') return completions.find((row) => row.userId === null)
  return completions.find((row) => row.userId !== null && activeOwnerIds.has(row.userId))
}

/**
 * One step of the tenant tab.
 * @param step - The registry step.
 * @param completions - The tenant's stored completions of this step, oldest first.
 * @param members - The tenant's live members.
 * @param canComplete - Whether staff could mark a tenant step complete in this tenant now.
 * @returns The step's detail.
 */
function stepDetailOf(
  step: OnboardingStep,
  completions: readonly OnboardingCompletionRow[],
  members: readonly OnboardingMemberRow[],
  canComplete: boolean
): OnboardingStepDetail {
  const activeOwnerIds = new Set(
    members
      .filter((member) => member.role === 'owner' && member.isActive)
      .map((member) => member.id)
  )
  const counted = countedCompletionOf(step, completions, activeOwnerIds)
  const entries =
    step.scope === 'member'
      ? members.map((member) =>
          memberStatusOf(
            member,
            completions.find((row) => row.userId === member.id)
          )
        )
      : undefined
  return {
    key: step.key,
    title: step.title,
    description: step.description,
    scope: step.scope,
    kind: step.completion.kind,
    required: step.required,
    // eslint-disable-next-line unicorn/no-null -- JSON null: not done
    completedAt: counted?.completedAt ?? null,
    // eslint-disable-next-line unicorn/no-null -- JSON null: not done
    source: counted?.source ?? null,
    // eslint-disable-next-line unicorn/no-null -- JSON null: automatic, or the actor was purged
    completedBy: counted?.completedBy ? personOf(counted.completedBy) : null,
    // eslint-disable-next-line unicorn/no-null -- JSON null: only a staff completion has a reason
    reason: counted?.reason ?? null,
    members:
      entries === undefined
        ? // eslint-disable-next-line unicorn/no-null -- JSON null: a tenant step has no per-member status
          null
        : {
            completed: entries.filter((entry) => entry.completedAt !== null).length,
            total: entries.length,
            entries,
          },
    canMarkComplete: canComplete && step.scope === 'tenant' && counted === undefined,
  }
}

/**
 * The strings of a metadata value that should be a string array.
 * @param value - The stored value.
 * @returns Its string items; none when it is not an array.
 */
function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/**
 * One reminder from its audit entry. Metadata is read defensively: an
 * entry is append-only and its schema is checked on write, but a missing
 * field must not fail the whole tab.
 * @param row - The audit entry.
 * @returns The reminder.
 */
function reminderViewOf(row: OnboardingReminderRow): OnboardingReminderView {
  const { reason, recipientCount, emailDomains, messageIds } = row.metadata
  return {
    id: row.id,
    sentAt: row.occurredAt,
    // eslint-disable-next-line unicorn/no-null -- JSON null: the staff member was purged
    sentBy: row.actor === null ? null : personOf(row.actor),
    reason: typeof reason === 'string' ? reason : '',
    recipientCount: typeof recipientCount === 'number' ? recipientCount : 0,
    emailDomains: stringsIn(emailDomains),
    messageIds: stringsIn(messageIds),
  }
}

/**
 * One customer tenant's onboarding, in any lifecycle state, for the staff
 * tenant tab: its state, every registry step with who completed it (staff
 * completions with their reason), each member step's per-member status,
 * whether a reminder could go now, and the reminder history.
 * @param tenantId - The tenant.
 * @param now - The current instant; injectable for tests.
 * @returns The detail.
 * @throws {HttpError} 404 when there is no such customer tenant (the platform tenant included).
 */
export async function getTenantOnboardingDetail(
  tenantId: string,
  now: Date = new Date()
): Promise<TenantOnboardingDetail> {
  const progress = await platformOnboardingRepository.findProgress(tenantId, progressOptionsAt(now))
  if (!progress) throw new HttpError(TENANT_NOT_FOUND, 404)
  const [members, completions, reminders, people] = await Promise.all([
    platformOnboardingRepository.listMembers(tenantId),
    platformOnboardingRepository.listCompletions(tenantId),
    platformOnboardingRepository.listReminders(tenantId, REMINDER_HISTORY_LIMIT),
    platformOnboardingRepository.usersById(
      progress.dismissedBy === null ? [] : [progress.dismissedBy]
    ),
  ])
  const owners = members.filter((member) => member.role === 'owner' && member.isActive)
  // eslint-disable-next-line unicorn/no-null -- JSON null: never reminded
  const lastSentAt = reminders[0]?.occurredAt ?? null
  const isOpen =
    progress.lifecycleState === 'active' &&
    progress.state !== 'not_tracked' &&
    progress.state !== 'awaiting_owner'
  const block = reminderBlockOf({
    lifecycleState: progress.lifecycleState,
    state: progress.state,
    ownerCount: owners.length,
    lastSentAt,
    now,
  })
  const reminder: OnboardingReminderAvailability = {
    canSend: block.blockedBy === null,
    blockedBy: block.blockedBy,
    lastSentAt,
    nextAllowedAt: block.nextAllowedAt,
    recipientCount: owners.length,
    emailDomains: emailDomainsOf(owners.map((owner) => owner.email)),
  }
  const dismissedBy = progress.dismissedBy === null ? undefined : people.get(progress.dismissedBy)
  return {
    tenant: {
      id: progress.id,
      name: progress.name,
      slug: progress.slug,
      lifecycleState: progress.lifecycleState,
    },
    state: progress.state,
    startedAt: progress.startedAt,
    lastProgressAt: progress.lastProgressAt,
    completedAt: progress.completedAt,
    dismissedAt: progress.dismissedAt,
    // eslint-disable-next-line unicorn/no-null -- JSON null: not dismissed, or by a purged user
    dismissedBy: dismissedBy === undefined ? null : personOf(dismissedBy),
    daysStuck: daysStuckOf(progress.state, progress.lastProgressAt, now),
    requiredDone: progress.requiredDone,
    requiredTotal: registryKeysOf().requiredKeys.length,
    nextStep: stepSummaryOf(nextRequiredStep(progress.doneKeys)),
    steps: ONBOARDING_STEPS.map((step) =>
      stepDetailOf(
        step,
        completions.filter((row) => row.stepKey === step.key),
        members,
        isOpen
      )
    ),
    reminder,
    reminders: reminders.map((row) => reminderViewOf(row)),
  }
}
