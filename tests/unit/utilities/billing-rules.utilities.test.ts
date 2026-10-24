import { describe, expect, it } from 'vite-plus/test'
import type { BillingStateInput } from '@/types/billing'
import {
  effectiveBillingState,
  extendTrialEnd,
  graceEndsAt,
  limitUsage,
  mergeEntitlements,
  planKeyForState,
} from '@/utilities/billing-rules.utilities'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-01-01T00:00:00Z')
/** Days after the fixed start time. */
const at = (days: number): Date => new Date(T0.getTime() + days * DAY)

const base: BillingStateInput = {
  state: 'active',
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  haltedAt: null,
  pausedAt: null,
}

/** A standing grant, with optional overrides. */
const grant = (key: string, value: boolean | number | null, extra = {}) => ({
  key,
  value,
  expiresAt: null,
  revokedAt: null,
  ...extra,
})

describe('effectiveBillingState', () => {
  const cases: Array<[string, Partial<BillingStateInput>, number, string]> = [
    ['trial on day 13', { state: 'trialing', trialEndsAt: at(14) }, 13, 'trialing'],
    ['trial on day 15', { state: 'trialing', trialEndsAt: at(14) }, 15, 'free'],
    [
      'cancelling, period end + 2',
      { currentPeriodEnd: at(30), cancelAtPeriodEnd: true },
      32,
      'active',
    ],
    [
      'cancelling, period end + 4',
      { currentPeriodEnd: at(30), cancelAtPeriodEnd: true },
      34,
      'free',
    ],
    ['past_due inside grace', { state: 'past_due', haltedAt: at(1) }, 5, 'past_due'],
    ['halted 8 days on', { state: 'halted', haltedAt: at(1) }, 9, 'free'],
    ['paused 8 days on', { state: 'paused', pausedAt: at(1) }, 9, 'free'],
    ['past_due beyond grace', { state: 'past_due', haltedAt: at(1) }, 9, 'free'],
    ['active, period end + 9', { currentPeriodEnd: at(30) }, 39, 'active'],
    ['active, period end + 11', { currentPeriodEnd: at(30) }, 41, 'free'],
    ['free stays free', { state: 'free' }, 100, 'free'],
  ]
  it.each(cases)('%s', (_name, patch, day, expected) => {
    expect(effectiveBillingState({ ...base, ...patch }, at(day), 7)).toBe(expected)
  })
})

describe('planKeyForState', () => {
  it('maps free to free and every other state to paid', () => {
    expect(planKeyForState('free')).toBe('free')
    expect(planKeyForState('active')).toBe('paid')
    expect(planKeyForState('past_due')).toBe('paid')
  })
})

describe('graceEndsAt', () => {
  it('adds the days to the halt or pause stamp', () => {
    expect(graceEndsAt({ haltedAt: at(1), pausedAt: null }, 7)).toEqual(at(8))
    expect(graceEndsAt({ haltedAt: null, pausedAt: at(2) }, 7)).toEqual(at(9))
    expect(graceEndsAt({ haltedAt: null, pausedAt: null }, 7)).toBeNull()
  })
})

describe('mergeEntitlements', () => {
  it('fills missing keys from the plan defaults and ignores unknown keys', () => {
    const { values, sources } = mergeEntitlements('free', { nope: 9 }, [], T0)
    expect(values).toEqual({ members: 3, advanced_example: false })
    expect(sources).toEqual({ members: 'plan', advanced_example: 'plan' })
    expect(mergeEntitlements('paid', {}, [], T0).values).toEqual({
      members: null,
      advanced_example: true,
    })
  })

  it('turns a feature on with a grant', () => {
    const { values, sources } = mergeEntitlements('free', {}, [grant('advanced_example', true)], T0)
    expect(values.advanced_example).toBe(true)
    expect(sources.advanced_example).toBe('grant')
  })

  it('raises a limit with the larger value, and null wins', () => {
    const over3 = mergeEntitlements('free', { members: 3 }, [grant('members', 10)], T0)
    expect(over3.values.members).toBe(10)
    expect(over3.sources.members).toBe('grant')
    expect(
      mergeEntitlements('free', { members: 3 }, [grant('members', null)], T0).values.members
    ).toBeNull()
    expect(
      mergeEntitlements('paid', { members: null }, [grant('members', 10)], T0).values.members
    ).toBeNull()
    const lower = mergeEntitlements('free', { members: 3 }, [grant('members', 2)], T0)
    expect(lower.values.members).toBe(3)
    expect(lower.sources.members).toBe('plan')
  })

  it('ignores expired and revoked grants and unknown grant keys', () => {
    const { values } = mergeEntitlements(
      'free',
      {},
      [
        grant('members', 10, { expiresAt: at(-1) }),
        grant('members', 20, { revokedAt: at(-1) }),
        grant('mystery', true),
      ],
      T0
    )
    expect(values).toEqual({ members: 3, advanced_example: false })
  })
})

describe('limitUsage', () => {
  it('flags the warning band only below the cap', () => {
    expect(limitUsage(5, 4).approaching).toBe(true)
    expect(limitUsage(5, 5).approaching).toBe(false)
    expect(limitUsage(5, 5).reached).toBe(true)
    expect(limitUsage(null, 50).approaching).toBe(false)
    expect(limitUsage(5, 3).approaching).toBe(false)
  })
})

describe('extendTrialEnd', () => {
  it('starts from now when the trial already ended or is unset', () => {
    expect(extendTrialEnd(at(-5), T0, 7)).toEqual(at(7))
    expect(extendTrialEnd(null, T0, 7)).toEqual(at(7))
  })
  it('starts from the current end when it is in the future', () => {
    expect(extendTrialEnd(at(3), T0, 7)).toEqual(at(10))
  })
})
