/**
 * @file deriveOnboardingState, which is pure: every state and its
 * precedence, the stuck boundary, optional and removed steps, and member
 * steps counting for the tenant once any active owner did them.
 */
import { describe, expect, it } from 'vitest'
import type { OnboardingStep } from '@/constants/onboarding.constants'
import type { OnboardingCompletion } from '@/database/models/onboarding-completion.model'
import {
  deriveOnboardingState,
  type DerivedOnboarding,
  type OnboardingDerivationInput,
} from '@/services/onboarding.service'

const DAY_MS = 24 * 60 * 60 * 1000
const STARTED = new Date('2026-09-01T00:00:00.000Z')
const OWNER = 'owner-1'
// eslint-disable-next-line unicorn/no-null -- the columns' and the derived contract's "none"
const NONE = null

/**
 * A time some days after the clock started.
 * @param days - Days after `STARTED`.
 * @returns The time.
 */
function atDay(days: number): Date {
  return new Date(STARTED.getTime() + days * DAY_MS)
}

/**
 * A completion row.
 * @param stepKey - The step.
 * @param completedAt - When.
 * @param userId - The member, for a member step.
 * @returns The row.
 */
function completion(stepKey: string, completedAt: Date, userId?: string): OnboardingCompletion {
  return {
    id: `${stepKey}-${userId ?? 'tenant'}`,
    tenantId: 'tenant-1',
    userId: userId ?? NONE,
    stepKey,
    source: userId ? 'customer' : 'auto',
    completedBy: userId ?? NONE,
    reason: NONE,
    completedAt,
  }
}

/**
 * Derive for a running tenant with no completions, at day 1, with `overrides`.
 * @param overrides - Input fields to replace.
 * @returns The derived onboarding.
 */
function derive(overrides: Partial<OnboardingDerivationInput> = {}): DerivedOnboarding {
  return deriveOnboardingState({
    tenant: { onboardingTracked: true, onboardingStartedAt: STARTED, onboardingDismissedAt: NONE },
    completions: [],
    activeOwnerIds: [OWNER],
    stuckAfterDays: 7,
    now: atDay(1),
    ...overrides,
  })
}

const bothRequired = [
  completion('configure_settings', atDay(1)),
  completion('invite_teammate', atDay(2)),
]

/**
 * A member-scoped manual step, for registries the tests pass in.
 * @param isRequired - Whether it is required.
 * @returns The step.
 */
function memberStep(isRequired: boolean): OnboardingStep {
  return {
    key: 'owner_step',
    title: 'Owner step',
    description: 'Done by a person.',
    scope: 'member',
    completion: { kind: 'manual' },
    required: isRequired,
  }
}

describe('deriveOnboardingState states', () => {
  it('reports not_tracked for an untracked tenant, whatever else holds', () => {
    const tenant = {
      onboardingTracked: false,
      onboardingStartedAt: STARTED,
      onboardingDismissedAt: NONE,
    }
    expect(derive({ tenant, completions: bothRequired }).state).toBe('not_tracked')
  })

  it('reports awaiting_owner for a tracked tenant whose clock has not started', () => {
    const tenant = {
      onboardingTracked: true,
      onboardingStartedAt: NONE,
      onboardingDismissedAt: NONE,
    }
    expect(derive({ tenant, now: atDay(30) })).toMatchObject({
      state: 'awaiting_owner',
      lastProgressAt: NONE,
    })
  })

  it('reports in_progress with the required counts', () => {
    const completions = [completion('configure_settings', atDay(1))]
    expect(derive({ completions, now: atDay(2) })).toMatchObject({
      state: 'in_progress',
      requiredDone: 1,
      requiredTotal: 2,
      completedAt: NONE,
      lastProgressAt: atDay(1),
    })
  })

  it('reports complete once every required step is done, at the last one; optional steps do not block it', () => {
    expect(derive({ completions: bothRequired, now: atDay(60) })).toMatchObject({
      state: 'complete',
      requiredDone: 2,
      requiredTotal: 2,
      completedAt: atDay(2),
    })
  })

  it('puts complete ahead of dismissed, and dismissed ahead of stuck', () => {
    const tenant = {
      onboardingTracked: true,
      onboardingStartedAt: STARTED,
      onboardingDismissedAt: atDay(1),
    }
    expect(derive({ tenant, completions: bothRequired }).state).toBe('complete')
    expect(derive({ tenant, now: atDay(60) }).state).toBe('dismissed')
  })
})

describe('deriveOnboardingState stuck boundary', () => {
  it('is in_progress just before N days without progress, and stuck at and after N days', () => {
    const completions = [completion('configure_settings', atDay(3))]
    const boundary = atDay(10).getTime()
    expect(derive({ completions, now: new Date(boundary - 1) }).state).toBe('in_progress')
    expect(derive({ completions, now: new Date(boundary) }).state).toBe('stuck')
    expect(derive({ completions, now: atDay(11) }).state).toBe('stuck')
  })

  it('counts from the clock start when nothing is complete', () => {
    expect(derive({ now: atDay(6) }).state).toBe('in_progress')
    expect(derive({ now: atDay(7) }).state).toBe('stuck')
  })

  it('takes the threshold it is given', () => {
    expect(derive({ now: atDay(2), stuckAfterDays: 2 }).state).toBe('stuck')
  })
})

describe('deriveOnboardingState steps', () => {
  it('ignores a completion whose step left the registry', () => {
    const derived = derive({ completions: [completion('verify_email', atDay(5))], now: atDay(6) })
    expect(derived.requiredDone).toBe(0)
    expect(derived.stepCompletions.has('verify_email')).toBe(false)
    expect(derived.lastProgressAt).toEqual(STARTED)
  })

  it('counts a member step for the tenant once any active owner did it, earliest first', () => {
    const steps = [memberStep(true)]
    const byTeammate = completion('owner_step', atDay(1), 'teammate-1')
    const byLaterOwner = completion('owner_step', atDay(3), 'owner-2')
    const byOwner = completion('owner_step', atDay(2), OWNER)

    const teammateOnly = derive({ steps, completions: [byTeammate] })
    const owners = derive({
      steps,
      completions: [byTeammate, byLaterOwner, byOwner],
      activeOwnerIds: [OWNER, 'owner-2'],
    })
    const inactiveOwner = derive({ steps, completions: [byOwner], activeOwnerIds: ['owner-2'] })

    expect(teammateOnly.state).toBe('in_progress')
    expect(owners).toMatchObject({ state: 'complete', completedAt: atDay(2) })
    expect(owners.stepCompletions.get('owner_step')).toBe(byOwner)
    expect(inactiveOwner.requiredDone).toBe(0)
  })

  it('treats a registry with no required step as complete from the clock start', () => {
    expect(derive({ steps: [memberStep(false)] })).toMatchObject({
      state: 'complete',
      requiredTotal: 0,
      completedAt: STARTED,
    })
  })
})
