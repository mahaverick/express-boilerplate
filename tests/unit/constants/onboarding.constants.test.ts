/**
 * @file Pins the onboarding registry to the spec's default steps, the value
 * sets the CHECK constraints are built from, and the load-time assertion
 * every registry passes through.
 */
import { describe, expect, it } from 'vitest'
import {
  assertOnboardingRegistry,
  ONBOARDING_RANGES,
  ONBOARDING_REASON_MAX_LENGTH,
  ONBOARDING_SCOPES,
  ONBOARDING_SOURCES,
  ONBOARDING_STATES,
  ONBOARDING_STEP_KEY_MAX_LENGTH,
  ONBOARDING_STEP_KEY_PATTERN,
  ONBOARDING_STEPS,
  ONBOARDING_TRIGGERS,
  onboardingStepByKey,
  stepsForTrigger,
  type OnboardingStep,
} from '@/constants/onboarding.constants'
import { MAX_REASON_LENGTH } from '@/validators/platform.validators'

/**
 * A valid registry entry, overridable per test.
 * @param overrides - Fields to replace.
 * @returns The step.
 */
function step(overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    key: 'example_step',
    title: 'Example',
    description: 'An example step.',
    scope: 'tenant',
    completion: { kind: 'manual' },
    required: false,
    ...overrides,
  }
}

describe('onboarding value sets', () => {
  it('match the spec', () => {
    expect(ONBOARDING_SCOPES).toEqual(['tenant', 'member'])
    expect(ONBOARDING_TRIGGERS).toEqual([
      'tenant_settings_updated',
      'teammate_invited',
      'teammate_joined',
    ])
    expect(ONBOARDING_SOURCES).toEqual(['auto', 'customer', 'staff'])
    expect(ONBOARDING_STATES).toEqual([
      'not_tracked',
      'awaiting_owner',
      'in_progress',
      'stuck',
      'complete',
      'dismissed',
    ])
    expect(ONBOARDING_RANGES).toEqual(['7d', '30d', '90d'])
  })

  it('bounds a completion reason exactly as the staff reason validator does', () => {
    expect(ONBOARDING_REASON_MAX_LENGTH).toBe(MAX_REASON_LENGTH)
  })
})

describe('ONBOARDING_STEPS', () => {
  it('holds the four default steps, in display order', () => {
    expect(
      ONBOARDING_STEPS.map(({ key, scope, completion, required }) => ({
        key,
        scope,
        completion,
        required,
      }))
    ).toEqual([
      {
        key: 'configure_settings',
        scope: 'tenant',
        completion: { kind: 'auto', on: 'tenant_settings_updated' },
        required: true,
      },
      {
        key: 'invite_teammate',
        scope: 'tenant',
        completion: { kind: 'auto', on: 'teammate_invited' },
        required: true,
      },
      {
        key: 'teammate_joined',
        scope: 'tenant',
        completion: { kind: 'auto', on: 'teammate_joined' },
        required: false,
      },
      {
        key: 'read_getting_started',
        scope: 'member',
        completion: { kind: 'manual' },
        required: false,
      },
    ])
  })

  it('gives every step a title and a description', () => {
    for (const entry of ONBOARDING_STEPS) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })
})

describe('assertOnboardingRegistry', () => {
  it('returns a valid registry unchanged', () => {
    const steps = [step(), step({ key: 'second_step', scope: 'member' })]
    expect(assertOnboardingRegistry(steps)).toBe(steps)
  })

  it('refuses a duplicate key', () => {
    expect(() => assertOnboardingRegistry([step(), step()])).toThrow(
      'Onboarding step key "example_step" is duplicated'
    )
  })

  it.each(['Example', 'example-step', '1_step', 'example__step', 'example_', ''])(
    'refuses the key %j, which is not snake_case',
    (key) => {
      expect(() => assertOnboardingRegistry([step({ key })])).toThrow('is not snake_case')
    }
  )

  it('refuses a key wider than its column', () => {
    const key = `k${'a'.repeat(ONBOARDING_STEP_KEY_MAX_LENGTH)}`
    expect(() => assertOnboardingRegistry([step({ key })])).toThrow('longer than its column')
  })

  it('refuses a trigger mapped to two steps of the same scope', () => {
    const completion = { kind: 'auto', on: 'teammate_invited' } as const
    expect(() =>
      assertOnboardingRegistry([step({ completion }), step({ key: 'other_step', completion })])
    ).toThrow('Onboarding trigger "teammate_invited" completes more than one tenant step')
  })

  it('accepts one trigger mapped to a tenant step and a member step', () => {
    const completion = { kind: 'auto', on: 'teammate_invited' } as const
    expect(() =>
      assertOnboardingRegistry([
        step({ completion }),
        step({ key: 'other_step', scope: 'member', completion }),
      ])
    ).not.toThrow()
  })
})

describe('ONBOARDING_STEP_KEY_PATTERN', () => {
  it('matches every default key', () => {
    for (const entry of ONBOARDING_STEPS) {
      expect(ONBOARDING_STEP_KEY_PATTERN.test(entry.key)).toBe(true)
    }
  })
})

describe('registry lookups', () => {
  it('finds a step by key, and nothing for an unknown key', () => {
    expect(onboardingStepByKey('invite_teammate')?.scope).toBe('tenant')
    expect(onboardingStepByKey('verify_email')).toBeUndefined()
  })

  it('maps each default trigger to its one tenant step', () => {
    expect(stepsForTrigger('tenant_settings_updated').map((entry) => entry.key)).toEqual([
      'configure_settings',
    ])
    expect(stepsForTrigger('teammate_invited').map((entry) => entry.key)).toEqual([
      'invite_teammate',
    ])
    expect(stepsForTrigger('teammate_joined').map((entry) => entry.key)).toEqual([
      'teammate_joined',
    ])
  })
})
