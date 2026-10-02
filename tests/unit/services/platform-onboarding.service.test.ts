/**
 * @file The pure parts of the staff onboarding service: the registry as
 * keys, the stuck cut-off, the next required step, days stuck, the
 * reminder rule, the recipients' domains and the reconcile's dated steps.
 * No database.
 */
import { describe, expect, it } from 'vitest'
import type { OnboardingStep } from '@/constants/onboarding.constants'
import {
  daysStuckOf,
  emailDomainsOf,
  nextRequiredStep,
  reconcileCompletionsOf,
  registryKeysOf,
  REMINDER_INTERVAL_MS,
  reminderBlockOf,
  stuckBeforeOf,
} from '@/services/platform-onboarding.service'

const NOW = new Date('2026-10-02T12:00:00.000Z')
// eslint-disable-next-line unicorn/no-null -- the functions' JSON null
const NONE = null
const DAY_MS = 24 * 60 * 60 * 1000

function step(key: string, overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    key,
    title: `Title ${key}`,
    description: `About ${key}`,
    scope: 'tenant',
    completion: { kind: 'manual' },
    required: true,
    ...overrides,
  }
}

const REGISTRY: readonly OnboardingStep[] = [
  step('first'),
  step('optional', { required: false }),
  step('second'),
  step('per_person', { scope: 'member', required: true }),
  step('per_person_optional', { scope: 'member', required: false }),
]

describe('registryKeysOf', () => {
  it('splits the registry by scope and lists the required keys of both', () => {
    expect(registryKeysOf(REGISTRY)).toEqual({
      tenantKeys: ['first', 'optional', 'second'],
      memberKeys: ['per_person', 'per_person_optional'],
      requiredKeys: ['first', 'second', 'per_person'],
    })
  })

  it('reads the default registry: two required tenant steps, no required member step', () => {
    expect(registryKeysOf()).toEqual({
      tenantKeys: ['configure_settings', 'invite_teammate', 'teammate_joined'],
      memberKeys: ['read_getting_started'],
      requiredKeys: ['configure_settings', 'invite_teammate'],
    })
  })
})

describe('stuckBeforeOf', () => {
  it('is now minus the given days', () => {
    expect(stuckBeforeOf(NOW, 7).toISOString()).toBe('2026-09-25T12:00:00.000Z')
  })

  it('defaults to ONBOARDING_STUCK_AFTER_DAYS (7 in the test environment)', () => {
    expect(stuckBeforeOf(NOW).getTime()).toBe(NOW.getTime() - 7 * DAY_MS)
  })
})

describe('nextRequiredStep', () => {
  it('is the first required step in registry order that is not done', () => {
    expect(nextRequiredStep([], REGISTRY)?.key).toBe('first')
    expect(nextRequiredStep(['first'], REGISTRY)?.key).toBe('second')
    expect(nextRequiredStep(['first', 'second'], REGISTRY)?.key).toBe('per_person')
  })

  it('skips optional steps and ignores done keys outside the registry', () => {
    expect(nextRequiredStep(['optional', 'retired'], REGISTRY)?.key).toBe('first')
  })

  it('is undefined once every required step is done', () => {
    expect(nextRequiredStep(['first', 'second', 'per_person'], REGISTRY)).toBeUndefined()
  })
})

describe('daysStuckOf', () => {
  it('counts whole days since the last progress for a stuck tenant', () => {
    const lastProgressAt = new Date(NOW.getTime() - 9 * DAY_MS - 60_000)
    expect(daysStuckOf('stuck', lastProgressAt, NOW)).toBe(9)
  })

  it.each(['in_progress', 'complete', 'dismissed', 'awaiting_owner', 'not_tracked'] as const)(
    'is null for %s',
    (state) => {
      const lastProgressAt = new Date(NOW.getTime() - 30 * DAY_MS)
      expect(daysStuckOf(state, lastProgressAt, NOW)).toBeNull()
    }
  )

  it('is null for a stuck tenant with no progress time', () => {
    expect(daysStuckOf('stuck', NONE, NOW)).toBeNull()
  })
})

describe('reminderBlockOf', () => {
  const allowed = {
    lifecycleState: 'active' as const,
    state: 'in_progress' as const,
    ownerCount: 1,
    lastSentAt: NONE,
    now: NOW,
  }

  it('allows an active, in-progress or stuck tenant with an owner and no recent reminder', () => {
    expect(reminderBlockOf(allowed)).toEqual({ blockedBy: NONE, nextAllowedAt: NONE })
    expect(reminderBlockOf({ ...allowed, state: 'stuck' }).blockedBy).toBeNull()
  })

  it.each(['suspended', 'archived'] as const)('blocks a %s tenant first', (lifecycleState) => {
    expect(
      reminderBlockOf({ ...allowed, lifecycleState, state: 'complete', ownerCount: 0 }).blockedBy
    ).toBe('tenant_state_conflict')
  })

  it.each(['complete', 'dismissed', 'awaiting_owner', 'not_tracked'] as const)(
    'blocks %s as not_in_progress, before the owner check',
    (state) => {
      expect(reminderBlockOf({ ...allowed, state, ownerCount: 0 }).blockedBy).toBe(
        'not_in_progress'
      )
    }
  )

  it('blocks a tenant with no active owner as no_owner, before the 24-hour check', () => {
    expect(reminderBlockOf({ ...allowed, ownerCount: 0, lastSentAt: NOW }).blockedBy).toBe(
      'no_owner'
    )
  })

  it('blocks for 24 hours after the latest reminder and says when the next may go', () => {
    const lastSentAt = new Date(NOW.getTime() - REMINDER_INTERVAL_MS + 60_000)
    expect(reminderBlockOf({ ...allowed, lastSentAt })).toEqual({
      blockedBy: 'reminded_recently',
      nextAllowedAt: new Date(lastSentAt.getTime() + REMINDER_INTERVAL_MS),
    })
  })

  it('allows the next reminder exactly 24 hours after the latest', () => {
    const lastSentAt = new Date(NOW.getTime() - REMINDER_INTERVAL_MS)
    expect(reminderBlockOf({ ...allowed, lastSentAt })).toEqual({
      blockedBy: NONE,
      nextAllowedAt: NONE,
    })
  })
})

describe('emailDomainsOf', () => {
  it('returns each hostname domain once, lowercased, in first-seen order', () => {
    expect(
      emailDomainsOf(['ada@Example.test', 'grace@other.test', 'linus@example.test', 'no-domain'])
    ).toEqual(['example.test', 'other.test'])
  })
})

describe('reconcileCompletionsOf', () => {
  const startedAt = new Date('2026-09-01T00:00:00.000Z')
  const nothing = {
    startedAt,
    settingsUpdatedAt: NONE,
    teammateInvitedAt: NONE,
    secondJoinAt: NONE,
  }

  it('restores nothing when nothing is on file', () => {
    expect(reconcileCompletionsOf(nothing)).toEqual([])
  })

  it('dates each default tenant step by its source event', () => {
    const settingsUpdatedAt = new Date('2026-09-02T00:00:00.000Z')
    const teammateInvitedAt = new Date('2026-09-03T00:00:00.000Z')
    const secondJoinAt = new Date('2026-09-04T00:00:00.000Z')

    expect(
      reconcileCompletionsOf({ startedAt, settingsUpdatedAt, teammateInvitedAt, secondJoinAt })
    ).toEqual([
      { stepKey: 'configure_settings', completedAt: settingsUpdatedAt },
      { stepKey: 'invite_teammate', completedAt: teammateInvitedAt },
      { stepKey: 'teammate_joined', completedAt: secondJoinAt },
    ])
  })

  it('dates teammate_joined at the start when the second member joined before the clock started', () => {
    const secondJoinAt = new Date(startedAt.getTime() - DAY_MS)

    expect(reconcileCompletionsOf({ ...nothing, secondJoinAt })).toEqual([
      { stepKey: 'teammate_joined', completedAt: startedAt },
    ])
  })
})
