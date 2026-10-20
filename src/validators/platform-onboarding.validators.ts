/**
 * @file The staff onboarding queries and the step-key route parameter.
 * `ONBOARDING_RANGES` is separate from `STATS_RANGES`, and the funnel
 * defaults to 30 days.
 */
import { z } from 'zod'
import { ONBOARDING_RANGES, onboardingStepByKey } from '@/constants/onboarding.constants'
import { ONBOARDING_TENANT_STATE_FILTERS } from '@/constants/platform.constants'
import { HttpError } from '@/errors/http-error'
import { listParamsSchema } from '@/validators/list.validators'

/**
 * The 404 an unknown or malformed step key answers.
 */
export const STEP_NOT_FOUND_MESSAGE =
  "We couldn't find this onboarding step. Refresh the checklist and try again."

/**
 * The error code of that 404: the value of `ONBOARDING_STEP_NOT_FOUND_CODE`
 * (onboarding.service.ts), restated because a validator imports no service; a
 * unit test pins the two equal.
 */
export const STEP_NOT_FOUND_CODE = 'onboarding_step_not_found'

/**
 * `GET /platform/onboarding/funnel` query: the window, 30 days unless asked otherwise.
 */
export const onboardingFunnelQuerySchema = z.object({
  range: z.enum(ONBOARDING_RANGES).default('30d'),
})

/**
 * `GET /platform/onboarding/tenants` query: one state (stuck unless asked
 * otherwise) and the shared list params, `search` matching the tenant name.
 * The default sort is the state's own order: longest stuck first for
 * `stuck`, most recently started first otherwise.
 */
export const onboardingTenantListSchema = listParamsSchema({
  sorts: ['progress', '-started', 'name'],
  defaultSort: (filters) => (filters.state === 'stuck' ? 'progress' : '-started'),
  filters: { state: z.enum(ONBOARDING_TENANT_STATE_FILTERS).default('stuck') },
})

/**
 * A parsed onboarding tenant list query.
 */
export type OnboardingTenantListQuery = z.output<typeof onboardingTenantListSchema>

/**
 * A route's `:key` as a registry step key, or a 404: an unknown key answers
 * like a malformed one.
 * @param raw - `request.params.key` as Express supplies it.
 * @throws {HttpError} 404 when `raw` names no registry step.
 */
export function parseStepKeyParameter(raw: unknown): string {
  if (typeof raw !== 'string' || onboardingStepByKey(raw) === undefined) {
    throw new HttpError(STEP_NOT_FOUND_MESSAGE, 404, STEP_NOT_FOUND_CODE)
  }
  return raw
}
