/**
 * @file The staff onboarding queries: the funnel's own ranges (30 days by
 * default, 90 allowed, unlike the Overview), the list's state filter
 * (stuck by default, `not_tracked` refused), the microsecond cursor,
 * `direction=prev` needing a cursor, and the step-key parameter.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { ONBOARDING_STEP_NOT_FOUND_CODE } from '@/services/onboarding.service'
import { encodeCursor } from '@/utilities/cursor.utilities'
import {
  onboardingFunnelQuerySchema,
  onboardingTenantSearchSchema,
  parseStepKeyParameter,
  STEP_NOT_FOUND_CODE,
  STEP_NOT_FOUND_MESSAGE,
} from '@/validators/platform-onboarding.validators'

const validCursor = (): string =>
  encodeCursor({ sortAt: '2026-09-30T08:15:02.123456Z', id: randomUUID() })

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

describe('onboardingTenantSearchSchema', () => {
  it('defaults to the stuck list, first page, 20 rows', () => {
    expect(onboardingTenantSearchSchema.parse({})).toEqual({
      state: 'stuck',
      direction: 'next',
      limit: 20,
    })
  })

  it.each(['stuck', 'in_progress', 'awaiting_owner', 'complete', 'dismissed'])(
    'accepts state=%s',
    (state) => {
      expect(onboardingTenantSearchSchema.parse({ state }).state).toBe(state)
    }
  )

  it.each([
    [{ state: 'not_tracked' }],
    [{ state: 'stalled' }],
    [{ limit: '51' }],
    [{ limit: '0' }],
    [{ cursor: 'not-a-cursor' }],
    [{ cursor: encodeCursor({ sortAt: '2026-09-30T08:15:02.123Z', id: randomUUID() }) }],
    [{ cursor: encodeCursor({ sortAt: '2026-09-30T08:15:02.123456Z', id: 'not-a-uuid' }) }],
  ])('refuses %j', (query) => {
    expect(onboardingTenantSearchSchema.safeParse(query).success).toBe(false)
  })

  it('decodes a cursor and pages back with it', () => {
    const parsed = onboardingTenantSearchSchema.parse({ cursor: validCursor(), direction: 'prev' })
    expect(parsed.cursor?.sortAt).toBe('2026-09-30T08:15:02.123456Z')
    expect(parsed.direction).toBe('prev')
  })

  it('refuses direction=prev without a cursor, naming the cursor field', () => {
    const result = onboardingTenantSearchSchema.safeParse({ direction: 'prev' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['cursor'])
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
