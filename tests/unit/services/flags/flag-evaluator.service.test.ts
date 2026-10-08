/**
 * @file The evaluator's rules beyond the golden fixtures: every fallback
 * reason, bucketing by the definition's aggregation, holdout, an unknown
 * variant, an inconclusive match, the property wrapper and the flag state.
 */
import { describe, expect, it, vi } from 'vitest'
import type { FlagEntry } from '@/constants/flags.constants'
import {
  definitionOf,
  evaluateFlag,
  flagStateOf,
  isFlagPropertyMatch,
  isInconclusiveMatchError,
} from '@/services/flags/flag-evaluator.service'
import type { FlagContext } from '@/types/flags'
import {
  flagDefinitionSchema,
  type ParsedDefinition,
  type ParsedSnapshot,
} from '@/validators/flag-definition.validators'

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null
const NONE = null
const USER_ID = '9595353c-7863-4490-968f-f49060804066'
const TENANT_ID = '0199b000-0000-7000-8000-00000000a1a1'

const BOOLEAN_ENTRY: FlagEntry = {
  key: 'probe_flag',
  description: 'A flag',
  kind: 'boolean',
  fallback: false,
  scope: 'user',
  client: false,
  apps: [],
  experiment: false,
}

const MULTIVARIATE_ENTRY: FlagEntry = {
  ...BOOLEAN_ENTRY,
  kind: 'multivariate',
  variants: ['control', 'bold'],
  fallback: 'control',
}

const CONTEXT: FlagContext = {
  distinctId: USER_ID,
  groups: { tenant: TENANT_ID },
  personProps: {
    platform_role: 'none',
    tenant_role: 'owner',
    app_env: 'prod',
    account_created_days: 30,
  },
  groupProps: { tenant: { tenant_created_days: 90 } },
  tenantId: TENANT_ID,
  sessionId: NONE,
}

const TENANTLESS: FlagContext = { ...CONTEXT, groups: {}, groupProps: {}, tenantId: NONE }

/**
 * A snapshot entry for `probe_flag`.
 * @param filters - The definition's filters.
 * @param fields - Snapshot-entry fields to change.
 * @returns The parsed definition.
 */
function parsed(
  filters: Record<string, unknown>,
  fields: Partial<ParsedDefinition> = {}
): ParsedDefinition {
  const raw = flagDefinitionSchema.parse({ id: 1, key: 'probe_flag', active: true, filters })
  return { key: 'probe_flag', id: 1, active: true, unsupported: NONE, raw, ...fields }
}

/**
 * A snapshot holding one definition, with the tenant at group index 0.
 * @param definition - The definition, or none.
 * @returns The snapshot.
 */
function snapshotWith(definition?: ParsedDefinition): ParsedSnapshot {
  return {
    etag: NONE,
    fetchedAt: '2026-10-05T12:00:00.000Z',
    checkedAt: '2026-10-05T12:00:00.000Z',
    propertyMatchingVersion: 1,
    tenantGroupIndex: 0,
    flags: definition === undefined ? {} : { probe_flag: definition },
  }
}

/**
 * A snapshot holding one `probe_flag` definition.
 * @param filters - The definition's filters.
 * @param fields - Snapshot-entry fields to change.
 * @returns The snapshot.
 */
function snapshotOf(
  filters: Record<string, unknown>,
  fields: Partial<ParsedDefinition> = {}
): ParsedSnapshot {
  return snapshotWith(parsed(filters, fields))
}

const ROLLOUT_100 = { groups: [{ properties: [], rollout_percentage: 100 }] }
const ON = { isConfigured: true }

describe('evaluateFlag fallbacks', () => {
  it('serves the fallback while flags are not configured', async () => {
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotOf(ROLLOUT_100), CONTEXT, { isConfigured: false })
    ).resolves.toEqual({ value: false, reason: 'fallback:unconfigured' })
  })

  it('serves the fallback with no snapshot', async () => {
    await expect(evaluateFlag(MULTIVARIATE_ENTRY, NONE, CONTEXT, ON)).resolves.toEqual({
      value: 'control',
      reason: 'fallback:snapshot_missing',
    })
  })

  it('serves the fallback for a flag missing from PostHog', async () => {
    await expect(evaluateFlag(BOOLEAN_ENTRY, snapshotWith(), CONTEXT, ON)).resolves.toEqual({
      value: false,
      reason: 'fallback:flag_missing',
    })
  })

  it('serves the fallback for an unsupported flag, never evaluating it', async () => {
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotOf(ROLLOUT_100, { unsupported: 'cohort' }), CONTEXT, ON)
    ).resolves.toEqual({ value: false, reason: 'fallback:unsupported' })
  })

  it('serves the fallback for an inactive flag', async () => {
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotOf(ROLLOUT_100, { active: false }), CONTEXT, ON)
    ).resolves.toEqual({ value: false, reason: 'fallback:inactive' })
  })

  it('serves the fallback for a tenant-aggregated flag with no tenant', async () => {
    const definition = parsed({
      aggregation_group_type_index: 0,
      groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 100 }],
    })
    await expect(
      evaluateFlag({ ...BOOLEAN_ENTRY, scope: 'tenant' }, snapshotWith(definition), TENANTLESS, ON)
    ).resolves.toEqual({ value: false, reason: 'fallback:no_tenant' })
  })

  it('serves the fallback for an aggregation index that is not the snapshot tenant index', async () => {
    const definition = parsed({
      aggregation_group_type_index: 3,
      groups: [{ aggregation_group_type_index: 3, properties: [], rollout_percentage: 100 }],
    })
    await expect(
      evaluateFlag({ ...BOOLEAN_ENTRY, scope: 'tenant' }, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({ value: false, reason: 'fallback:unsupported' })
  })

  it('serves the fallback for a property value core cannot read, and never throws', async () => {
    const definition = parsed({
      groups: [
        {
          properties: [{ key: 'app_env', type: 'person', operator: 'semver_gt', value: '1.0.0' }],
          rollout_percentage: 100,
        },
      ],
    })
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({
      value: false,
      reason: 'fallback:inconclusive',
    })
  })
})

describe('evaluateFlag rules', () => {
  it('matches a full rollout with the condition index', async () => {
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotOf(ROLLOUT_100), CONTEXT, ON)
    ).resolves.toEqual({ value: true, reason: 'condition_match', conditionIndex: 0 })
  })

  it('treats a null rollout as 100 %', async () => {
    const definition = parsed({ groups: [{ properties: [], rollout_percentage: NONE }] })
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({
      value: true,
      reason: 'condition_match',
      conditionIndex: 0,
    })
  })

  it('reports out_of_rollout when properties matched but the rollout did not, else no_condition_match', async () => {
    const zero = parsed({ groups: [{ properties: [], rollout_percentage: 0 }] })
    await expect(evaluateFlag(BOOLEAN_ENTRY, snapshotWith(zero), CONTEXT, ON)).resolves.toEqual({
      value: false,
      reason: 'out_of_rollout',
    })
    const adminsOnly = parsed({
      groups: [
        {
          properties: [
            { key: 'platform_role', type: 'person', operator: 'exact', value: ['admin'] },
          ],
          rollout_percentage: 100,
        },
      ],
    })
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotWith(adminsOnly), CONTEXT, ON)
    ).resolves.toEqual({
      value: false,
      reason: 'no_condition_match',
    })
  })

  it('walks conditions in order, so an out-of-rollout first condition falls through to the next', async () => {
    const definition = parsed({
      groups: [
        { properties: [], rollout_percentage: 0 },
        {
          properties: [{ key: 'tenant_role', type: 'person', operator: 'exact', value: ['owner'] }],
          rollout_percentage: 100,
        },
      ],
    })
    await expect(
      evaluateFlag(BOOLEAN_ENTRY, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({
      value: true,
      reason: 'condition_match',
      conditionIndex: 1,
    })
  })

  it('serves a condition variant override that names a flag variant', async () => {
    const definition = parsed({
      groups: [{ properties: [], rollout_percentage: 100, variant: 'bold' }],
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 100 },
          { key: 'bold', rollout_percentage: 0 },
        ],
      },
    })
    await expect(
      evaluateFlag(MULTIVARIATE_ENTRY, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({ value: 'bold', reason: 'condition_match', conditionIndex: 0 })
  })

  it('serves the fallback and reports a variant the registry does not declare', async () => {
    const definition = parsed({
      groups: [{ properties: [], rollout_percentage: 100 }],
      multivariate: { variants: [{ key: 'loud', rollout_percentage: 100 }] },
    })
    const onUnknownVariant = vi.fn()
    await expect(
      evaluateFlag(MULTIVARIATE_ENTRY, snapshotWith(definition), CONTEXT, {
        isConfigured: true,
        onUnknownVariant,
      })
    ).resolves.toEqual({ value: 'control', reason: 'fallback:unsupported' })
    expect(onUnknownVariant).toHaveBeenCalledWith('probe_flag')
  })

  it('holds out a user ahead of every condition, serving the fallback with the holdout variant', async () => {
    const definition = parsed({
      groups: [{ properties: [], rollout_percentage: 100 }],
      holdout: { id: 3605, exclusion_percentage: 100 },
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'bold', rollout_percentage: 50 },
        ],
      },
    })
    await expect(
      evaluateFlag(MULTIVARIATE_ENTRY, snapshotWith(definition), CONTEXT, ON)
    ).resolves.toEqual({ value: 'control', reason: 'holdout', holdoutVariant: 'holdout-3605' })
  })

  it('buckets a tenant-aggregated flag on the tenant, so every member gets one answer', async () => {
    const definition = parsed({
      aggregation_group_type_index: 0,
      groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 50 }],
    })
    const entry: FlagEntry = { ...BOOLEAN_ENTRY, scope: 'tenant' }
    const results = await Promise.all(
      ['0199b000-0000-7000-8000-000000000011', '0199b000-0000-7000-8000-000000000012'].map(
        (userId) =>
          evaluateFlag(entry, snapshotWith(definition), { ...CONTEXT, distinctId: userId }, ON)
      )
    )
    const expected = { value: false, reason: 'out_of_rollout' }
    expect(results).toEqual([expected, expected])
  })

  it('evaluates a $group_key condition the same with and without the group_key_names PostHog injects', async () => {
    const OTHER_TENANT_ID = '0199b000-0000-7000-8000-00000000b2b2'
    const entry: FlagEntry = { ...BOOLEAN_ENTRY, scope: 'tenant' }
    const targeting = (
      value: string[],
      names?: Record<string, string>
    ): Promise<{ value: unknown; reason: string }> =>
      evaluateFlag(
        entry,
        snapshotOf({
          aggregation_group_type_index: 0,
          groups: [
            {
              aggregation_group_type_index: 0,
              properties: [
                {
                  key: '$group_key',
                  type: 'group',
                  group_type_index: 0,
                  operator: 'exact',
                  value,
                  ...(names !== undefined && { group_key_names: names }),
                },
              ],
              rollout_percentage: 100,
            },
          ],
        }),
        CONTEXT,
        ON
      )

    const matched = { value: true, reason: 'condition_match', conditionIndex: 0 }
    const unmatched = { value: false, reason: 'no_condition_match' }
    await expect(targeting([TENANT_ID])).resolves.toEqual(matched)
    await expect(targeting([TENANT_ID], { [OTHER_TENANT_ID]: 'Another tenant' })).resolves.toEqual(
      matched
    )
    await expect(targeting([OTHER_TENANT_ID])).resolves.toEqual(unmatched)
    await expect(targeting([OTHER_TENANT_ID], { [TENANT_ID]: 'This tenant' })).resolves.toEqual(
      unmatched
    )
  })
})

describe('isFlagPropertyMatch', () => {
  it('treats an absent key as false, except is_not and is_not_set', () => {
    expect(
      isFlagPropertyMatch(
        { key: 'signup_date', type: 'person', operator: 'exact', value: ['x'] },
        CONTEXT,
        1
      )
    ).toBe(false)
    expect(
      isFlagPropertyMatch(
        { key: 'signup_date', type: 'person', operator: 'is_not', value: ['x'] },
        CONTEXT,
        1
      )
    ).toBe(true)
    expect(
      isFlagPropertyMatch(
        { key: 'signup_date', type: 'person', operator: 'is_not_set', value: 'is_not_set' },
        CONTEXT,
        1
      )
    ).toBe(true)
  })

  it('matches an integer trait against a string list, as PostHog does', () => {
    expect(
      isFlagPropertyMatch(
        { key: 'account_created_days', type: 'person', operator: 'exact', value: ['30'] },
        CONTEXT,
        1
      )
    ).toBe(true)
    expect(
      isFlagPropertyMatch(
        { key: 'account_created_days', type: 'person', operator: 'gt', value: '7' },
        CONTEXT,
        1
      )
    ).toBe(true)
    expect(
      isFlagPropertyMatch(
        { key: 'account_created_days', type: 'person', operator: 'lt', value: '7' },
        CONTEXT,
        NONE
      )
    ).toBe(false)
  })

  it('treats a missing operator as exact', () => {
    expect(isFlagPropertyMatch({ key: 'app_env', type: 'person', value: 'PROD' }, CONTEXT, 1)).toBe(
      true
    )
  })

  it('matches the implicit distinct_id and $group_key, and group traits from the tenant group', () => {
    expect(
      isFlagPropertyMatch({ key: 'distinct_id', type: 'person', value: [USER_ID] }, CONTEXT, 1)
    ).toBe(true)
    expect(
      isFlagPropertyMatch(
        { key: '$group_key', type: 'group', group_type_index: 0, value: [TENANT_ID] },
        CONTEXT,
        1
      )
    ).toBe(true)
    expect(
      isFlagPropertyMatch(
        {
          key: 'tenant_created_days',
          type: 'group',
          group_type_index: 0,
          operator: 'gt',
          value: '30',
        },
        CONTEXT,
        1
      )
    ).toBe(true)
  })

  it('never lets a supplied $group_key override the real group key', () => {
    const forged: FlagContext = { ...CONTEXT, groupProps: { tenant: { $group_key: 'forged' } } }
    expect(
      isFlagPropertyMatch({ key: '$group_key', type: 'group', value: ['forged'] }, forged, 1)
    ).toBe(false)
  })

  it('finds no group trait without a tenant', () => {
    expect(
      isFlagPropertyMatch({ key: '$group_key', type: 'group', value: [TENANT_ID] }, TENANTLESS, 1)
    ).toBe(false)
  })
})

describe('isInconclusiveMatchError', () => {
  it("recognises core's error by name too, since two copies of core may be loaded", () => {
    /**
     * An error from a second copy of core: same name, different class.
     */
    class ForeignInconclusiveMatchError extends Error {
      override name = 'InconclusiveMatchError'
    }
    expect(
      isInconclusiveMatchError(new ForeignInconclusiveMatchError('Property x not found'))
    ).toBe(true)
    expect(isInconclusiveMatchError(new Error('other'))).toBe(false)
    expect(isInconclusiveMatchError('InconclusiveMatchError')).toBe(false)
  })
})

describe('flagStateOf and definitionOf', () => {
  it('names a definition missing, unsupported, inactive or active, unsupported first', () => {
    expect(flagStateOf(undefined)).toBe('missing')
    expect(flagStateOf(parsed(ROLLOUT_100, { unsupported: 'cohort', active: false }))).toBe(
      'unsupported'
    )
    expect(flagStateOf(parsed(ROLLOUT_100, { active: false }))).toBe('inactive')
    expect(flagStateOf(parsed(ROLLOUT_100))).toBe('active')
  })

  it('finds only own keys, so a registry key such as constructor never reads the prototype', () => {
    const snapshot = snapshotOf(ROLLOUT_100)
    expect(definitionOf(snapshot, 'probe_flag')?.key).toBe('probe_flag')
    expect(definitionOf(snapshot, 'constructor')).toBeUndefined()
    expect(definitionOf(snapshot, 'toString')).toBeUndefined()
  })
})
