/**
 * @file The golden fixtures: 129 contexts PostHog's remote `/flags`
 * answered during the planning probe (41 flags), replayed through the
 * evaluator. Each case checks the spec value and reason for a registry entry
 * with fallback `false` / `variants[0]`, the PostHog reason code it maps to,
 * the PostHog value on a match or a holdout, and what the parser says about
 * the flag. Unsupported flags are evaluated anyway (forced supported here),
 * because they still pin PostHog's semantics for absent properties, dates
 * and semver.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FLAG_REASON_POSTHOG_CODES, type FlagEntry } from '@/constants/flags.constants'
import { evaluateFlag } from '@/services/flags/flag-evaluator.service'
import type { FlagContext, FlagReason, FlagScope } from '@/types/flags'
import {
  detectUnsupported,
  flagDefinitionSchema,
  type ParsedSnapshot,
} from '@/validators/flag-definition.validators'

const DAY_MS = 86_400_000
// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null
const NONE = null

/**
 * One captured case, as `golden-fixtures.json` stores it.
 */
interface GoldenFixture {
  flagKey: string
  definition: unknown
  context: {
    distinctId: string
    groups: { tenant?: string }
    personProps: Record<string, string | number>
    groupProps: { tenant?: Record<string, string | number> }
  }
  expected: { value: boolean | string; reason: string; conditionIndex?: number }
  specExpected: {
    entry: {
      kind: 'boolean' | 'multivariate'
      fallback: boolean | string
      variants?: string[]
      scope: FlagScope
    }
    value: boolean | string
    reason: FlagReason
    conditionIndex?: number
  }
  specUnsupported?: string
  timeRelative?: { signup_date_days_ago: number }
}

const FIXTURES_PATH = path.resolve(process.cwd(), 'tests/fixtures/flag-golden-fixtures.json')

const file = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as {
  meta: { property_matching_version: number }
  fixtures: GoldenFixture[]
}

/**
 * The probe's name for a construct, where it differs from the parser's.
 */
const CONSTRUCT_NAMES: Readonly<Record<string, string>> = {
  property_key_outside_traits: 'property_key',
}

/**
 * The registry entry a case was evaluated against.
 * @param fixture - The case.
 * @returns The entry.
 */
function entryOf(fixture: GoldenFixture): FlagEntry {
  const base = {
    key: fixture.flagKey,
    description: 'Golden fixture',
    scope: fixture.specExpected.entry.scope,
    client: false,
    apps: [],
    experiment: false,
  }
  const { variants } = fixture.specExpected.entry
  if (variants === undefined || fixture.specExpected.entry.kind === 'boolean') {
    return { ...base, kind: 'boolean', fallback: false }
  }
  const [first, ...rest] = variants
  if (first === undefined) throw new Error(`fixture ${fixture.flagKey} has no variants`)
  return { ...base, kind: 'multivariate', variants: [first, ...rest], fallback: first }
}

/**
 * The context of a case, with a relative signup date rebuilt against now.
 * @param fixture - The case.
 * @param now - The moment to rebuild relative dates from.
 * @returns The context.
 */
function contextOf(fixture: GoldenFixture, now: number): FlagContext {
  const personProperties = { ...fixture.context.personProps }
  if (fixture.timeRelative !== undefined) {
    personProperties.signup_date = new Date(
      now - fixture.timeRelative.signup_date_days_ago * DAY_MS
    ).toISOString()
  }
  return {
    distinctId: fixture.context.distinctId,
    groups: fixture.context.groups,
    personProps: personProperties,
    groupProps: fixture.context.groupProps,
    tenantId: fixture.context.groups.tenant ?? NONE,
    sessionId: NONE,
  }
}

describe('golden fixtures', () => {
  it('holds the 129 cases the probe captured, under property_matching_version 1', () => {
    expect(file.fixtures).toHaveLength(129)
    expect(file.meta.property_matching_version).toBe(1)
  })

  const cases = file.fixtures.map((fixture, index) => [index, fixture.flagKey, fixture] as const)
  it.each(cases)('case %i (%s) matches PostHog', async (_index, _key, fixture) => {
    const raw = flagDefinitionSchema.parse(fixture.definition)
    const entry = entryOf(fixture)
    const snapshot: ParsedSnapshot = {
      etag: NONE,
      fetchedAt: '2026-10-05T07:50:01.724Z',
      checkedAt: '2026-10-05T07:50:01.724Z',
      propertyMatchingVersion: 1,
      tenantGroupIndex: 0,
      flags: {
        [fixture.flagKey]: {
          key: fixture.flagKey,
          id: raw.id,
          active: raw.active,
          unsupported: NONE,
          raw,
        },
      },
    }

    const result = await evaluateFlag(entry, snapshot, contextOf(fixture, Date.now()), {
      isConfigured: true,
    })

    const { specExpected, expected } = fixture
    expect(result).toEqual({
      value: specExpected.value,
      reason: specExpected.reason,
      ...(specExpected.conditionIndex !== undefined && {
        conditionIndex: specExpected.conditionIndex,
      }),
      ...(specExpected.reason === 'holdout' && { holdoutVariant: expected.value }),
    })
    expect(FLAG_REASON_POSTHOG_CODES[result.reason]).toBe(expected.reason)
    if (result.reason === 'condition_match') {
      expect(result.value).toBe(expected.value)
      expect(result.conditionIndex).toBe(expected.conditionIndex)
    }
    const construct = fixture.specUnsupported
    expect(detectUnsupported(raw, entry, 0)).toBe(
      construct === undefined ? NONE : (CONSTRUCT_NAMES[construct] ?? construct)
    )
  })
})
