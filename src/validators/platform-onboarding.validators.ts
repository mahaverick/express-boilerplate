/**
 * @file The staff onboarding queries and the step-key route parameter.
 * `ONBOARDING_RANGES` is separate from the Overview's `STATS_RANGES`, and
 * defaults to 30 days.
 */
import { z } from 'zod'
import { ONBOARDING_RANGES, onboardingStepByKey } from '@/constants/onboarding.constants'
import { ONBOARDING_TENANT_STATE_FILTERS } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import { cursorField, sortAtField } from '@/validators/cursor.validators'
import { directionField, pageLimitField } from '@/validators/platform.validators'

/**
 * The 404 an unknown or malformed step key answers.
 */
export const STEP_NOT_FOUND_MESSAGE = 'Onboarding step not found'

/**
 * Its code: the value of `ONBOARDING_STEP_NOT_FOUND_CODE` (onboarding.service.ts),
 * restated because a validator imports no service; a unit test pins the two equal.
 */
export const STEP_NOT_FOUND_CODE = 'onboarding_step_not_found'

/**
 * The onboarding list cursor's decoded shape: the last row's sort
 * timestamp (microsecond text) and id.
 */
export const onboardingCursorSchema = z.strictObject({
  sortAt: sortAtField,
  id: z.uuid(),
})

/**
 * `GET /platform/onboarding/funnel` query: the window, 30 days unless asked otherwise.
 */
export const onboardingFunnelQuerySchema = z.object({
  range: z.enum(ONBOARDING_RANGES).default('30d'),
})

/**
 * The validated funnel query.
 */
export type OnboardingFunnelQuery = z.infer<typeof onboardingFunnelQuerySchema>

/**
 * `GET /platform/onboarding/tenants` query string: one state (stuck unless
 * asked otherwise) and SP2 keyset paging. `direction=prev` needs a cursor.
 */
export const onboardingTenantSearchSchema = z
  .object({
    state: z.enum(ONBOARDING_TENANT_STATE_FILTERS).default('stuck'),
    cursor: cursorField(onboardingCursorSchema).optional(),
    direction: directionField,
    limit: pageLimitField,
  })
  .superRefine((query, context) => {
    if (query.direction === 'prev' && query.cursor === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'cursor is required when direction is prev.',
      })
    }
  })

/**
 * The validated list query, with the cursor already decoded.
 */
export type OnboardingTenantSearchQuery = z.infer<typeof onboardingTenantSearchSchema>

/**
 * A route's `:key` as a registry step key, or a 404: an unknown key answers
 * like a malformed one.
 * @param raw - `request.params.key` as Express supplies it.
 * @returns The key.
 * @throws {HttpError} 404 when `raw` names no registry step.
 */
export function parseStepKeyParameter(raw: unknown): string {
  if (typeof raw !== 'string' || onboardingStepByKey(raw) === undefined) {
    throw new HttpError(STEP_NOT_FOUND_MESSAGE, 404, STEP_NOT_FOUND_CODE)
  }
  return raw
}
