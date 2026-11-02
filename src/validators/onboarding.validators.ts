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
    .max(
      ONBOARDING_STEP_KEY_MAX_LENGTH,
      `Step key must be at most ${String(ONBOARDING_STEP_KEY_MAX_LENGTH)} characters.`
    )
    .regex(
      ONBOARDING_STEP_KEY_PATTERN,
      'Step key must start with a lowercase letter and use lowercase letters, digits and single underscores, such as invite_teammate.'
    ),
})
