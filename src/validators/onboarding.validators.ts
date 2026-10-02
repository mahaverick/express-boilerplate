/**
 * @file Onboarding route parameters.
 */
import { z } from 'zod'
import {
  ONBOARDING_STEP_KEY_MAX_LENGTH,
  ONBOARDING_STEP_KEY_PATTERN,
} from '@/constants/onboarding.constants'

/**
 * The `:key` of `POST /tenants/:slug/onboarding/steps/:key/complete`: a step
 * key's shape. Whether a step has that key is the service's 404.
 */
export const onboardingStepParametersSchema = z.object({
  key: z
    .string()
    .max(ONBOARDING_STEP_KEY_MAX_LENGTH, 'Step key is too long.')
    .regex(ONBOARDING_STEP_KEY_PATTERN, 'Step key must be lowercase snake_case.'),
})
