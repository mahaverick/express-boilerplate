/**
 * @file The step-key route parameter: a key's shape only, so an unknown but
 * well-formed key reaches the service's 404 and anything else answers 400.
 */
import { describe, expect, it } from 'vitest'
import { onboardingStepParametersSchema } from '@/validators/onboarding.validators'

describe('onboardingStepParametersSchema', () => {
  it.each(['read_getting_started', 'unknown_but_well_formed', 'step2'])('accepts %s', (key) => {
    expect(onboardingStepParametersSchema.safeParse({ slug: 'acme', key }).success).toBe(true)
  })

  it.each(['Read', 'read-getting-started', '_read', 'read_', '', `k${'a'.repeat(64)}`])(
    'refuses %j',
    (key) => {
      expect(onboardingStepParametersSchema.safeParse({ key }).success).toBe(false)
    }
  )
})
