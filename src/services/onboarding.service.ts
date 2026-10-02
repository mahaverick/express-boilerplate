/**
 * @file Onboarding: the single writer of completions (`completeOnboardingStep`),
 * the derived state every reader shares (`deriveOnboardingState`), the
 * customer's view and writes, and the domain-event subscriber that completes
 * `auto` steps. Actions staff take through platform access never count as
 * customer progress, and only members write through the customer API.
 */
import { getEnv } from '@/configs/env.config'
import {
  ONBOARDING_STEPS,
  onboardingStepByKey,
  stepsForTrigger,
  type OnboardingSource,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingTrigger,
} from '@/constants/onboarding.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { OnboardingCompletion } from '@/database/models/onboarding-completion.model'
import type { Tenant } from '@/database/models/tenant.model'
import { HttpError } from '@/errors/http-error'
import { OnboardingCompletionRepository } from '@/repositories/onboarding-completion.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { record } from '@/services/audit.service'
import {
  db,
  withTransaction,
  type DbExecutor,
  type DbTransaction,
} from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { lockActorRole } from '@/services/tenant-membership.service'
import type { Actor } from '@/types/actor'
import type { DomainEventContext, DomainEventOf } from '@/types/domain-event'
import type { CustomerOnboardingState, TenantOnboardingView } from '@/types/onboarding'

const completionRepository = new OnboardingCompletionRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Error code: no registry step has this key.
 */
export const ONBOARDING_STEP_NOT_FOUND_CODE = 'onboarding_step_not_found'

/**
 * Error code: the tenant's onboarding is not tracked, or waits for its first owner.
 */
export const NOT_TRACKED_CODE = 'not_tracked'

/**
 * Error code: a member step was asked to complete for the whole tenant.
 */
export const MEMBER_STEP_CODE = 'member_step'

/**
 * Error code: a tenant step was asked to complete for one member.
 */
export const SCOPE_MISMATCH_CODE = 'scope_mismatch'

/**
 * Error code: a customer tried to tick a step that completes on its own.
 */
export const NOT_MANUAL_CODE = 'not_manual'

/**
 * Error code: dismissing a dismissed checklist, or restoring one that is not dismissed.
 */
export const DISMISS_STATE_CODE = 'dismiss_state'

/**
 * What `completeOnboardingStep` records.
 */
export interface CompleteOnboardingStepInput {
  tenantId: string
  /**
   * The member, for a member step; omitted for a tenant step.
   */
  userId?: string | undefined
  stepKey: string
  source: OnboardingSource
  /**
   * The customer or staff user recording it; ignored for `auto`.
   */
  completedBy?: string | undefined
  /**
   * Required for `staff`.
   */
  reason?: string | undefined
  /**
   * When the step was done. Only the reconcile passes it, to date a
   * restored step by the event that proves it; every live path leaves it
   * out and the row is stamped now.
   */
  completedAt?: Date | undefined
}

/**
 * Whether a tenant's onboarding clock is running: tracked and started.
 * @param tenant - The tenant row.
 * @returns True when steps may complete.
 */
function isOnboardingStarted(
  tenant: Pick<Tenant, 'onboardingTracked' | 'onboardingStartedAt'>
): boolean {
  return tenant.onboardingTracked && tenant.onboardingStartedAt !== null
}

/**
 * Record one step as complete, once: a repeat is a no-op. The single writer
 * of `onboarding_completions`, exported for product code that completes a
 * step of its own (an `auto` member step, say). A dismissed tenant still
 * records.
 * @param input - The tenant, the member for a member step, the step, and who recorded it.
 * @param executor - Where to run the queries. Defaults to the pool.
 * @returns The new completion, or undefined when the step was already complete.
 * @throws {HttpError} 404 `onboarding_step_not_found` for an unknown key; 409 `member_step` for a member step with no member; 409 `scope_mismatch` for a tenant step with a member; 400 for a staff completion with no reason; 404 when the tenant is gone; 409 `not_tracked` when its onboarding is untracked or waits for its first owner.
 */
export async function completeOnboardingStep(
  input: CompleteOnboardingStepInput,
  executor: DbExecutor = db
): Promise<OnboardingCompletion | undefined> {
  const step = onboardingStepByKey(input.stepKey)
  if (!step) throw new HttpError('Onboarding step not found', 404, ONBOARDING_STEP_NOT_FOUND_CODE)
  if (step.scope === 'member' && input.userId === undefined) {
    throw new HttpError('This step is done by each member, not the tenant.', 409, MEMBER_STEP_CODE)
  }
  if (step.scope === 'tenant' && input.userId !== undefined) {
    throw new HttpError('This step is done once for the tenant.', 409, SCOPE_MISMATCH_CODE)
  }
  if (input.source === 'staff' && !input.reason) {
    throw new HttpError('A staff completion needs a reason.', 400)
  }
  const tenant = await tenantRepository.findById(input.tenantId, {}, executor)
  if (!tenant) throw new HttpError('Tenant not found', 404)
  if (!isOnboardingStarted(tenant)) {
    throw new HttpError('Onboarding is not tracked for this tenant.', 409, NOT_TRACKED_CODE)
  }
  return completionRepository.insertIfNew(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      stepKey: step.key,
      source: input.source,
      completedBy: input.source === 'auto' ? undefined : input.completedBy,
      reason: input.reason,
      completedAt: input.completedAt,
    },
    executor
  )
}

/**
 * What `deriveOnboardingState` reads.
 */
export interface OnboardingDerivationInput {
  tenant: Pick<Tenant, 'onboardingTracked' | 'onboardingStartedAt' | 'onboardingDismissedAt'>
  /**
   * Every completion in the tenant; rows for steps no longer in the registry are ignored.
   */
  completions: readonly OnboardingCompletion[]
  /**
   * The owners who can still sign in: a member step counts for the tenant once any of them did it.
   */
  activeOwnerIds: readonly string[]
  stuckAfterDays: number
  now: Date
  /**
   * The registry. Defaults to `ONBOARDING_STEPS`.
   */
  steps?: readonly OnboardingStep[]
}

/**
 * A tenant's onboarding progress, derived on read.
 */
export interface DerivedOnboarding {
  state: OnboardingState
  requiredDone: number
  requiredTotal: number
  /**
   * When the last required step completed; null until complete.
   */
  completedAt: Date | null
  /**
   * The latest counted completion, or the clock's start when later; null before it starts.
   */
  lastProgressAt: Date | null
  /**
   * The completion that counts for the tenant, by step key: the tenant's own
   * row for a tenant step, the earliest active owner's for a member step.
   */
  stepCompletions: ReadonlyMap<string, OnboardingCompletion>
}

/**
 * The completion that counts for the tenant for one step.
 * @param step - The registry step.
 * @param completions - Every completion in the tenant.
 * @param owners - The active owners' ids.
 * @returns The counting completion, or undefined.
 */
function countingCompletion(
  step: OnboardingStep,
  completions: readonly OnboardingCompletion[],
  owners: ReadonlySet<string>
): OnboardingCompletion | undefined {
  const matching = completions.filter(
    (row) =>
      row.stepKey === step.key &&
      (step.scope === 'tenant'
        ? row.userId === null
        : row.userId !== null && owners.has(row.userId))
  )
  return matching.toSorted((a, b) => a.completedAt.getTime() - b.completedAt.getTime())[0]
}

/**
 * The latest of some optional times.
 * @param times - The times; null and undefined are skipped.
 * @returns The latest, or null when there is none.
 */
function latestOf(times: ReadonlyArray<Date | null | undefined>): Date | null {
  let latest: Date | undefined
  for (const time of times) {
    if (time && (!latest || time.getTime() > latest.getTime())) latest = time
  }
  // eslint-disable-next-line unicorn/no-null -- the derived contract uses null for "none"
  return latest ?? null
}

/**
 * A tenant's onboarding state, from its row, its completions and its active
 * owners. Pure. State precedence: `not_tracked` (untracked), `awaiting_owner`
 * (tracked, not started), `complete` (every required step done), `dismissed`,
 * `stuck` (no progress for `stuckAfterDays` or more), `in_progress`.
 * @param input - What to derive from.
 * @returns The state, the required-step counts, and the times.
 */
export function deriveOnboardingState(input: OnboardingDerivationInput): DerivedOnboarding {
  const steps = input.steps ?? ONBOARDING_STEPS
  const owners = new Set(input.activeOwnerIds)
  const stepCompletions = new Map<string, OnboardingCompletion>()
  for (const step of steps) {
    const completion = countingCompletion(step, input.completions, owners)
    if (completion) stepCompletions.set(step.key, completion)
  }
  const required = steps.filter((step) => step.required)
  const requiredDone = required.filter((step) => stepCompletions.has(step.key)).length
  const lastProgressAt = latestOf([
    input.tenant.onboardingStartedAt,
    ...Array.from(stepCompletions.values(), (completion) => completion.completedAt),
  ])
  const isComplete = isOnboardingStarted(input.tenant) && requiredDone === required.length
  const completedAt = latestOf(
    isComplete
      ? [
          input.tenant.onboardingStartedAt,
          ...required.map((step) => stepCompletions.get(step.key)?.completedAt),
        ]
      : []
  )
  return {
    state: stateOf(input, { isComplete, lastProgressAt }),
    requiredDone,
    requiredTotal: required.length,
    completedAt,
    lastProgressAt,
    stepCompletions,
  }
}

/**
 * The state, by `deriveOnboardingState`'s precedence.
 * @param input - The derivation input.
 * @param progress - Whether every required step is done, and the last progress time.
 * @param progress.isComplete - Every required step is done.
 * @param progress.lastProgressAt - The last progress time.
 * @returns The state.
 */
function stateOf(
  input: OnboardingDerivationInput,
  progress: { isComplete: boolean; lastProgressAt: Date | null }
): OnboardingState {
  if (!input.tenant.onboardingTracked) return 'not_tracked'
  if (input.tenant.onboardingStartedAt === null) return 'awaiting_owner'
  if (progress.isComplete) return 'complete'
  if (input.tenant.onboardingDismissedAt !== null) return 'dismissed'
  const idleMs = input.now.getTime() - (progress.lastProgressAt?.getTime() ?? input.now.getTime())
  if (idleMs >= input.stuckAfterDays * MS_PER_DAY) return 'stuck'
  return 'in_progress'
}

/**
 * The state as a customer sees it: `stuck` and `awaiting_owner` are staff
 * concepts. A stuck tenant is in progress; one awaiting its owner is not
 * tracked yet, so a member who joined before the owner sees no checklist
 * (its writes answer 409 `not_tracked` until the owner accepts).
 * @param state - The derived state.
 * @returns The customer's state.
 */
function customerStateOf(state: OnboardingState): CustomerOnboardingState {
  if (state === 'stuck') return 'in_progress'
  if (state === 'awaiting_owner') return 'not_tracked'
  return state
}

/**
 * An optional time as an ISO string.
 * @param date - The time, or null.
 * @returns Its ISO string, or null.
 */
function isoOrNull(date: Date | null | undefined): string | null {
  // eslint-disable-next-line unicorn/no-null -- the wire contract sends JSON null
  return date ? date.toISOString() : null
}

/**
 * A tenant's onboarding as a customer sees it: every registry step in order,
 * tenant steps with the tenant's completion and member steps with the
 * viewer's own (none for a viewer with no membership, such as staff).
 * @param tenantId - The tenant.
 * @param viewer - The reader.
 * @param viewer.userId - Their user id when they are a member, or null.
 * @param now - The time to derive the state at. Defaults to now.
 * @returns The view.
 * @throws {HttpError} 404 when the tenant is gone.
 */
export async function getTenantOnboarding(
  tenantId: string,
  viewer: { userId: string | null },
  now: Date = new Date()
): Promise<TenantOnboardingView> {
  const tenant = await tenantRepository.findById(tenantId)
  if (!tenant) throw new HttpError('Tenant not found', 404)
  const [completions, activeOwnerIds] = await Promise.all([
    completionRepository.listForTenant(tenantId),
    userMembershipRepository.listActiveOwnerIds(tenantId),
  ])
  const derived = deriveOnboardingState({
    tenant,
    completions,
    activeOwnerIds,
    stuckAfterDays: getEnv().ONBOARDING_STUCK_AFTER_DAYS,
    now,
  })
  const steps = ONBOARDING_STEPS.map((step) => {
    const completion =
      step.scope === 'tenant'
        ? derived.stepCompletions.get(step.key)
        : completions.find(
            (row) =>
              viewer.userId !== null && row.stepKey === step.key && row.userId === viewer.userId
          )
    return {
      key: step.key,
      title: step.title,
      description: step.description,
      scope: step.scope,
      kind: step.completion.kind,
      required: step.required,
      completedAt: isoOrNull(completion?.completedAt),
      // eslint-disable-next-line unicorn/no-null -- the wire contract sends JSON null
      source: completion?.source ?? null,
    }
  })
  return {
    state: customerStateOf(derived.state),
    steps,
    requiredDone: derived.requiredDone,
    requiredTotal: derived.requiredTotal,
    completedAt: isoOrNull(derived.completedAt),
    dismissedAt: isoOrNull(tenant.onboardingDismissedAt),
  }
}

/**
 * Complete every `auto` step a trigger maps to, for a running tenant; an
 * untracked or unstarted tenant is skipped quietly. A member step completes
 * for `subjectUserId`.
 * @param trigger - The trigger.
 * @param tenant - The tenant, as just read.
 * @param subjectUserId - The member the event is about.
 */
async function completeTriggeredSteps(
  trigger: OnboardingTrigger,
  tenant: Tenant,
  subjectUserId: string
): Promise<void> {
  if (!isOnboardingStarted(tenant)) return
  for (const step of stepsForTrigger(trigger)) {
    await completeOnboardingStep({
      tenantId: tenant.id,
      userId: step.scope === 'member' ? subjectUserId : undefined,
      stepKey: step.key,
      source: 'auto',
    })
  }
}

/**
 * Read the tenant an event names, unless the actor used platform access.
 * @param tenantId - The tenant.
 * @param context - The event's context.
 * @returns The tenant, or undefined when the event does not count or the tenant is gone.
 */
async function countedTenant(
  tenantId: string,
  context: DomainEventContext
): Promise<Tenant | undefined> {
  if (context.access === 'platform') return undefined
  return tenantRepository.findById(tenantId)
}

/**
 * `tenant_settings_updated`: completes the steps on that trigger.
 * @param event - The event.
 * @param context - Its context.
 */
async function onTenantSettingsUpdated(
  event: DomainEventOf<'tenant_settings_updated'>,
  context: DomainEventContext
): Promise<void> {
  const tenant = await countedTenant(event.tenantId, context)
  if (tenant) await completeTriggeredSteps('tenant_settings_updated', tenant, event.actorId)
}

/**
 * `teammate_invited`: completes the steps on that trigger.
 * @param event - The event.
 * @param context - Its context.
 */
async function onTeammateInvited(
  event: DomainEventOf<'teammate_invited'>,
  context: DomainEventContext
): Promise<void> {
  const tenant = await countedTenant(event.tenantId, context)
  if (tenant) await completeTriggeredSteps('teammate_invited', tenant, event.actorId)
}

/**
 * `invitation_accepted`: an owner joining a tracked tenant that waits for one
 * starts its clock; anyone joining a started tenant who is not its first
 * member completes the `teammate_joined` steps.
 * @param event - The event.
 * @param context - Its context.
 */
async function onInvitationAccepted(
  event: DomainEventOf<'invitation_accepted'>,
  context: DomainEventContext
): Promise<void> {
  const tenant = await countedTenant(event.tenantId, context)
  if (!tenant?.onboardingTracked) return
  if (tenant.onboardingStartedAt === null) {
    if (event.role === 'owner') await tenantRepository.startOnboarding(tenant.id, event.at)
    return
  }
  if (!event.wasFirstMember) await completeTriggeredSteps('teammate_joined', tenant, event.userId)
}

/**
 * Subscribe onboarding to the domain events it completes steps from.
 * `createApp()` calls it; calling it again changes nothing.
 */
export function registerOnboardingSubscribers(): void {
  subscribeDomainEvent('tenant_settings_updated', onTenantSettingsUpdated)
  subscribeDomainEvent('teammate_invited', onTeammateInvited)
  subscribeDomainEvent('invitation_accepted', onInvitationAccepted)
}

/**
 * Re-read the actor's access under lock and refuse anyone who is not a
 * member at `minimum` or above: staff acting through platform access get
 * the 404 a non-member gets.
 * @param actor - The signed-in user.
 * @param tenantId - The tenant.
 * @param minimum - The lowest membership role admitted.
 * @param tx - The transaction to hold the locks in.
 * @throws {HttpError} 404 `Tenant not found` when the actor is not a member; 403 when their role is below `minimum`.
 */
async function lockMemberAccess(
  actor: Actor,
  tenantId: string,
  minimum: MembershipRole,
  tx: DbTransaction
): Promise<void> {
  const { access } = await lockActorRole(actor, tenantId, minimum, tx)
  if (access !== 'member') throw new HttpError('Tenant not found', 404)
}

/**
 * Tick a manual step as a member: a member step completes for the actor
 * (any member), a tenant step for the tenant (admin or owner). Ticking a done
 * step again changes nothing. A dismissed tenant still records.
 * @param actor - The signed-in member.
 * @param tenantId - The tenant.
 * @param stepKey - The step.
 * @returns The onboarding as the actor now sees it.
 * @throws {HttpError} 404 `onboarding_step_not_found` for an unknown key; 409 `not_manual` for a step that completes on its own; 404 `Tenant not found` when the actor is not a member; 403 for a tenant step below admin; 409 `not_tracked` when the tenant's onboarding is untracked or waits for its first owner.
 */
export async function completeStepAsMember(
  actor: Actor,
  tenantId: string,
  stepKey: string
): Promise<TenantOnboardingView> {
  const step = onboardingStepByKey(stepKey)
  if (!step) throw new HttpError('Onboarding step not found', 404, ONBOARDING_STEP_NOT_FOUND_CODE)
  if (step.completion.kind !== 'manual') {
    throw new HttpError('This step completes on its own.', 409, NOT_MANUAL_CODE)
  }
  await withTransaction(async (tx) => {
    await lockMemberAccess(actor, tenantId, step.scope === 'member' ? 'viewer' : 'admin', tx)
    await completeOnboardingStep(
      {
        tenantId,
        userId: step.scope === 'member' ? actor.userId : undefined,
        stepKey: step.key,
        source: 'customer',
        completedBy: actor.userId,
      },
      tx
    )
  })
  return getTenantOnboarding(tenantId, { userId: actor.userId })
}

/**
 * Lock the tenant after the actor's access, and refuse one whose onboarding
 * is not running.
 * @param tenantId - The tenant.
 * @param tx - The transaction.
 * @returns The locked tenant.
 * @throws {HttpError} 404 when the tenant is gone; 409 `not_tracked` when its onboarding is untracked or waits for its first owner.
 */
async function lockRunningTenant(tenantId: string, tx: DbTransaction): Promise<Tenant> {
  const tenant = await tenantRepository.lockById(tenantId, tx)
  if (!tenant) throw new HttpError('Tenant not found', 404)
  if (!isOnboardingStarted(tenant)) {
    throw new HttpError('Onboarding is not tracked for this tenant.', 409, NOT_TRACKED_CODE)
  }
  return tenant
}

/**
 * Dismiss the checklist, as an owner by membership, and audit it in the same
 * transaction. A dismissed tenant is shown to staff as dismissed, not stuck.
 * @param actor - The signed-in owner.
 * @param tenantId - The tenant.
 * @returns The onboarding as the actor now sees it.
 * @throws {HttpError} 404 `Tenant not found` when the actor is not a member; 403 below owner; 409 `not_tracked`; 409 `dismiss_state` when it is already dismissed.
 */
export async function dismissOnboarding(
  actor: Actor,
  tenantId: string
): Promise<TenantOnboardingView> {
  await withTransaction(async (tx) => {
    await lockMemberAccess(actor, tenantId, 'owner', tx)
    const tenant = await lockRunningTenant(tenantId, tx)
    if (tenant.onboardingDismissedAt !== null) {
      throw new HttpError('Getting started is already dismissed.', 409, DISMISS_STATE_CODE)
    }
    await tenantRepository.setOnboardingDismissed(tenantId, actor.userId, new Date(), tx)
    await record(
      {
        action: 'onboarding.dismissed',
        actor,
        access: 'member',
        tenantId,
        targetId: tenantId,
        metadata: {},
      },
      tx
    )
  })
  return getTenantOnboarding(tenantId, { userId: actor.userId })
}

/**
 * Undo a dismissal, as an owner by membership, and audit it in the same transaction.
 * @param actor - The signed-in owner.
 * @param tenantId - The tenant.
 * @returns The onboarding as the actor now sees it.
 * @throws {HttpError} 404 `Tenant not found` when the actor is not a member; 403 below owner; 409 `not_tracked`; 409 `dismiss_state` when it is not dismissed.
 */
export async function undismissOnboarding(
  actor: Actor,
  tenantId: string
): Promise<TenantOnboardingView> {
  await withTransaction(async (tx) => {
    await lockMemberAccess(actor, tenantId, 'owner', tx)
    const tenant = await lockRunningTenant(tenantId, tx)
    if (tenant.onboardingDismissedAt === null) {
      throw new HttpError('Getting started is not dismissed.', 409, DISMISS_STATE_CODE)
    }
    // eslint-disable-next-line unicorn/no-null -- null clears the dismissal
    await tenantRepository.setOnboardingDismissed(tenantId, null, null, tx)
    await record(
      {
        action: 'onboarding.undismissed',
        actor,
        access: 'member',
        tenantId,
        targetId: tenantId,
        metadata: {},
      },
      tx
    )
  })
  return getTenantOnboarding(tenantId, { userId: actor.userId })
}
