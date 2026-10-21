/**
 * @file The staff onboarding queries: the funnel's own ranges (30 days by
 * default, 90 allowed, unlike the Overview), the list's state filter
 * (stuck by default, `not_tracked` refused), its state-chosen default sort,
 * `direction=prev` needing a cursor, and the step-key parameter.
 */
import { describe, expect, it } from 'vite-plus/test'
import { HttpError } from '@/errors/http-error'
import { ONBOARDING_STEP_NOT_FOUND_CODE } from '@/services/onboarding.service'
import {
  onboardingFunnelQuerySchema,
  onboardingTenantListSchema,
  parseStepKeyParameter,
  STEP_NOT_FOUND_CODE,
  STEP_NOT_FOUND_MESSAGE,
} from '@/validators/platform-onboarding.validators'

describe('onboardingFunnelQuerySchema', () => {
  it('defaults to 30d', () => {
    expect(onboardingFunnelQuerySchema.parse({})).toEqual({ range: '30d' })
  })

  it.each(['7d', '30d', '90d'])('accepts range=%s', (range) => {
    expect(onboardingFunnelQuerySchema.parse({ range }).range).toBe(range)
  })

  it.each(['1d', '365d', ''])('refuses range=%j', (range) => {
    expect(onboardingFunnelQuerySchema.safeParse({ range }).success).toBe(false)
  })
})

describe('onboardingTenantListSchema', () => {
  it('defaults to the stuck list, first page, 20 rows', () => {
    const parsed = onboardingTenantListSchema.parse({})
    expect(parsed.filters).toEqual({ state: 'stuck' })
    expect(parsed.params).toMatchObject({ direction: 'next', limit: 20, sort: 'progress' })
  })

  it('sorts the stuck tab by progress and every other tab by start', () => {
    expect(onboardingTenantListSchema.parse({}).params.sort).toBe('progress')
    expect(onboardingTenantListSchema.parse({ state: 'complete' }).params.sort).toBe('-started')
  })

  it('takes an explicit sort over the state default', () => {
    expect(onboardingTenantListSchema.parse({ sort: 'name' }).params.sort).toBe('name')
    expect(
      onboardingTenantListSchema.parse({ state: 'complete', sort: 'progress' }).params.sort
    ).toBe('progress')
  })

  it.each(['stuck', 'in_progress', 'awaiting_owner', 'complete', 'dismissed'])(
    'accepts state=%s',
    (state) => {
      expect(onboardingTenantListSchema.parse({ state }).filters.state).toBe(state)
    }
  )

  it('takes one state, not a list', () => {
    expect(onboardingTenantListSchema.safeParse({ state: 'stuck,complete' }).success).toBe(false)
  })

  it.each([
    [{ state: 'not_tracked' }],
    [{ state: 'stalled' }],
    [{ limit: '101' }],
    [{ limit: '0' }],
    [{ sort: 'started' }],
  ])('refuses %j', (query) => {
    expect(onboardingTenantListSchema.safeParse(query).success).toBe(false)
  })

  it('refuses direction=prev without a cursor, naming the cursor field', () => {
    const result = onboardingTenantListSchema.safeParse({ direction: 'prev' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['cursor'])
  })

  it('binds a cursor to the state: the same search under another state hashes differently', () => {
    const stuck = onboardingTenantListSchema.parse({ sort: 'name' }).params.scope
    const complete = onboardingTenantListSchema.parse({ state: 'complete', sort: 'name' }).params
    expect(complete.scope).not.toBe(stuck)
  })
})

describe('parseStepKeyParameter', () => {
  it('returns a registry key', () => {
    expect(parseStepKeyParameter('configure_settings')).toBe('configure_settings')
  })

  it.each([undefined, '', 'Configure_Settings', 'no_such_step', ['configure_settings']])(
    'answers 404 for %j',
    (raw) => {
      let caught: unknown
      try {
        parseStepKeyParameter(raw)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(HttpError)
      expect(caught).toMatchObject({
        statusCode: 404,
        message: STEP_NOT_FOUND_MESSAGE,
        code: STEP_NOT_FOUND_CODE,
      })
    }
  )

  it("answers with the customer routes' code for an unknown step", () => {
    expect(STEP_NOT_FOUND_CODE).toBe(ONBOARDING_STEP_NOT_FOUND_CODE)
  })
})
