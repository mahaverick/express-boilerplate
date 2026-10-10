/**
 * @file The onboarding steps registry and its fixed value sets. The registry
 * is code, served to both apps, which never keep a copy of the step list. A
 * derived project adds a step here, then completes it from a domain-event
 * trigger or a direct `completeOnboardingStep` call (onboarding.service.ts).
 */

/**
 * Who a step is done by: once for the whole tenant, or once per member.
 */
export const ONBOARDING_SCOPES = ['tenant', 'member'] as const

/**
 * One of `ONBOARDING_SCOPES`.
 */
export type OnboardingScope = (typeof ONBOARDING_SCOPES)[number]

/**
 * The domain events an `auto` step can complete on (domain-event.ts).
 */
export const ONBOARDING_TRIGGERS = [
  'tenant_settings_updated',
  'teammate_invited',
  'teammate_joined',
] as const

/**
 * One of `ONBOARDING_TRIGGERS`.
 */
export type OnboardingTrigger = (typeof ONBOARDING_TRIGGERS)[number]

/**
 * Who recorded a completion: the server from a trigger, a customer ticking a
 * manual step, or staff marking a step complete with a reason.
 */
export const ONBOARDING_SOURCES = ['auto', 'customer', 'staff'] as const

/**
 * One of `ONBOARDING_SOURCES`.
 */
export type OnboardingSource = (typeof ONBOARDING_SOURCES)[number]

/**
 * A tenant's derived onboarding state, in precedence order
 * (`deriveOnboardingState`, onboarding.service.ts).
 */
export const ONBOARDING_STATES = [
  'not_tracked',
  'awaiting_owner',
  'in_progress',
  'stuck',
  'complete',
  'dismissed',
] as const

/**
 * One of `ONBOARDING_STATES`.
 */
export type OnboardingState = (typeof ONBOARDING_STATES)[number]

/**
 * The staff funnel's date ranges, separate from `STATS_RANGES`.
 */
export const ONBOARDING_RANGES = ['7d', '30d', '90d'] as const

/**
 * One of `ONBOARDING_RANGES`.
 */
export type OnboardingRange = (typeof ONBOARDING_RANGES)[number]

/**
 * A step key: lowercase snake_case, starting with a letter.
 */
export const ONBOARDING_STEP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/**
 * The widest step key `onboarding_completions.step_key` stores.
 */
export const ONBOARDING_STEP_KEY_MAX_LENGTH = 64

/**
 * The widest staff reason a completion stores, equal to `MAX_REASON_LENGTH`
 * (platform.validators.ts; onboarding.constants.test.ts pins the two).
 */
export const ONBOARDING_REASON_MAX_LENGTH = 500

/**
 * How a step completes: on a domain-event trigger, or when someone ticks it.
 */
type OnboardingStepCompletion = { kind: 'auto'; on: OnboardingTrigger } | { kind: 'manual' }

/**
 * One registry entry.
 */
export interface OnboardingStep {
  key: string
  title: string
  description: string
  scope: OnboardingScope
  completion: OnboardingStepCompletion
  /**
   * Whether the tenant counts as complete only once this step is done.
   */
  required: boolean
}

/**
 * Refuse a registry the rest of onboarding cannot serve: a duplicate key, a
 * key that is not snake_case or is wider than its column, or a trigger mapped
 * to more than one step of the same scope.
 * @param steps - The registry, in display order.
 * @returns The same array, once every entry passes.
 * @throws {Error} Naming the first offending key or trigger.
 */
export function assertOnboardingRegistry(
  steps: readonly OnboardingStep[]
): readonly OnboardingStep[] {
  const keys = new Set<string>()
  const triggers = new Set<string>()
  for (const step of steps) {
    if (!ONBOARDING_STEP_KEY_PATTERN.test(step.key)) {
      throw new Error(`Onboarding step key "${step.key}" is not snake_case`)
    }
    if (step.key.length > ONBOARDING_STEP_KEY_MAX_LENGTH) {
      throw new Error(`Onboarding step key "${step.key}" is longer than its column`)
    }
    if (keys.has(step.key)) throw new Error(`Onboarding step key "${step.key}" is duplicated`)
    keys.add(step.key)
    if (step.completion.kind !== 'auto') continue
    const slot = `${step.scope}:${step.completion.on}`
    if (triggers.has(slot)) {
      throw new Error(
        `Onboarding trigger "${step.completion.on}" completes more than one ${step.scope} step`
      )
    }
    triggers.add(slot)
  }
  return steps
}

/**
 * The registry, in display order. Steps complete in any order.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = assertOnboardingRegistry([
  {
    key: 'configure_settings',
    title: 'Configure your workspace settings',
    description: 'Set the timezone and locale your team works in.',
    scope: 'tenant',
    completion: { kind: 'auto', on: 'tenant_settings_updated' },
    required: true,
  },
  {
    key: 'invite_teammate',
    title: 'Invite a teammate',
    description: 'Send an invitation to someone you work with.',
    scope: 'tenant',
    completion: { kind: 'auto', on: 'teammate_invited' },
    required: true,
  },
  {
    key: 'teammate_joined',
    title: 'A teammate joins',
    description: 'Someone you invited accepts and joins the workspace.',
    scope: 'tenant',
    completion: { kind: 'auto', on: 'teammate_joined' },
    required: false,
  },
  {
    key: 'read_getting_started',
    title: 'Read the getting started guide',
    description: 'Learn how the workspace fits together, then mark this done.',
    scope: 'member',
    completion: { kind: 'manual' },
    required: false,
  },
])

/**
 * One registry entry by key.
 * @param key - The step key.
 * @returns The step, or undefined when no step has this key.
 */
export function onboardingStepByKey(key: string): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find((step) => step.key === key)
}

/**
 * The `auto` steps a trigger completes, at most one per scope.
 * @param trigger - The trigger.
 * @returns The steps, in registry order.
 */
export function stepsForTrigger(trigger: OnboardingTrigger): readonly OnboardingStep[] {
  return ONBOARDING_STEPS.filter(
    (step) => step.completion.kind === 'auto' && step.completion.on === trigger
  )
}
