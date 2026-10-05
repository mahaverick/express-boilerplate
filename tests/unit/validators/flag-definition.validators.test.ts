/**
 * @file The definitions parser: the top-level shape, which flags are kept,
 * stripped or refused, and `detectUnsupported` with one case per construct
 * of spec §4.5 (each verified against PostHog in the planning probe).
 */
import { describe, expect, it } from 'vitest'
import { flagEntry, type FlagEntry } from '@/constants/flags.constants'
import {
  detectUnsupported,
  flagDefinitionSchema,
  parseDefinitionsResponse,
  type FlagDefinitionJson,
} from '@/validators/flag-definition.validators'

const NOW = new Date('2026-10-05T12:00:00.000Z')
// eslint-disable-next-line unicorn/no-null -- PostHog's JSON null
const NONE = null

const USER_ENTRY: FlagEntry = {
  key: 'probe_flag',
  description: 'A user flag',
  kind: 'boolean',
  fallback: false,
  scope: 'user',
  client: false,
  apps: [],
  experiment: false,
}

const TENANT_ENTRY: FlagEntry = { ...USER_ENTRY, scope: 'tenant' }

const MULTIVARIATE_ENTRY: FlagEntry = {
  ...USER_ENTRY,
  kind: 'multivariate',
  variants: ['control', 'bold'],
  fallback: 'control',
}

/**
 * A raw person-aggregated definition, as PostHog sends it.
 * @param overrides - Flag-level fields to change.
 * @param filters - `filters` fields to change.
 * @returns The raw JSON.
 */
function rawDefinition(
  overrides: Record<string, unknown> = {},
  filters: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 931_750,
    key: 'probe_flag',
    name: 'Probe flag',
    team_id: 644_121,
    version: 3,
    active: true,
    deleted: false,
    ensure_experience_continuity: false,
    has_experiment: false,
    evaluation_runtime: 'all',
    bucketing_identifier: 'distinct_id',
    evaluation_contexts: [],
    filters: {
      aggregation_group_type_index: NONE,
      groups: [{ aggregation_group_type_index: NONE, properties: [], rollout_percentage: 37 }],
      ...filters,
    },
    ...overrides,
  }
}

/**
 * A validated definition with one condition holding `properties`.
 * @param properties - The condition's properties.
 * @param filters - `filters` fields to change.
 * @returns The parsed definition.
 */
function withProperties(
  properties: Record<string, unknown>[],
  filters: Record<string, unknown> = {}
): FlagDefinitionJson {
  return flagDefinitionSchema.parse(
    rawDefinition(
      {},
      {
        groups: [{ aggregation_group_type_index: NONE, properties, rollout_percentage: 100 }],
        ...filters,
      }
    )
  )
}

/**
 * A validated definition.
 * @param overrides - Flag-level fields to change.
 * @param filters - `filters` fields to change.
 * @returns The parsed definition.
 */
function definition(
  overrides: Record<string, unknown> = {},
  filters: Record<string, unknown> = {}
): FlagDefinitionJson {
  return flagDefinitionSchema.parse(rawDefinition(overrides, filters))
}

/**
 * A validated tenant-aggregated definition at group index 0.
 * @param conditionFields - Fields of its one condition.
 * @returns The parsed definition.
 */
function tenantDefinition(conditionFields: Record<string, unknown> = {}): FlagDefinitionJson {
  return definition(
    {},
    {
      aggregation_group_type_index: 0,
      groups: [
        {
          aggregation_group_type_index: 0,
          properties: [],
          rollout_percentage: 50,
          ...conditionFields,
        },
      ],
    }
  )
}

describe('parseDefinitionsResponse', () => {
  it('parses an empty project', () => {
    expect(
      parseDefinitionsResponse(
        {
          cohorts: {},
          flags: [],
          group_type_mapping: { '0': 'tenant' },
          minimal_flag_called_events: false,
          property_matching_version: 1,
        },
        'W/"e257855b59155725"',
        NOW
      )
    ).toEqual({
      etag: 'W/"e257855b59155725"',
      fetchedAt: '2026-10-05T12:00:00.000Z',
      checkedAt: '2026-10-05T12:00:00.000Z',
      propertyMatchingVersion: 1,
      tenantGroupIndex: 0,
      flags: {},
    })
  })

  it('resolves the tenant group index from group_type_mapping, never a fixed number', () => {
    const snapshot = parseDefinitionsResponse(
      { flags: [], group_type_mapping: { '0': 'company', '2': 'tenant' } },
      NONE,
      NOW
    )
    expect(snapshot.tenantGroupIndex).toBe(2)
    expect(snapshot.propertyMatchingVersion).toBeNull()
  })

  it('has no tenant group index when the project has no tenant group type', () => {
    expect(
      parseDefinitionsResponse({ flags: [], group_type_mapping: {} }, NONE, NOW).tenantGroupIndex
    ).toBeNull()
  })

  it('keeps inactive flags, drops deleted ones and strips unknown flag-level fields', () => {
    const snapshot = parseDefinitionsResponse(
      {
        flags: [
          rawDefinition(
            { key: 'example_beta_page', active: false, brand_new_field: 1 },
            {
              aggregation_group_type_index: 0,
              groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 0 }],
            }
          ),
          rawDefinition({ key: 'gone_flag', deleted: true }),
        ],
        group_type_mapping: { '0': 'tenant' },
        property_matching_version: 1,
      },
      NONE,
      NOW
    )
    expect(Object.keys(snapshot.flags)).toEqual(['example_beta_page'])
    const parsed = snapshot.flags.example_beta_page
    expect(parsed).toMatchObject({ key: 'example_beta_page', active: false, unsupported: NONE })
    expect(parsed?.raw).not.toHaveProperty('brand_new_field')
    expect(parsed?.raw).not.toHaveProperty('name')
    expect(parsed?.raw).not.toHaveProperty('team_id')
  })

  it('marks a flag that fails the schema malformed, keeping its key, and keeps the rest', () => {
    const snapshot = parseDefinitionsResponse(
      {
        flags: [
          { key: 'broken_flag', id: 7, active: true, filters: { groups: 'not a list' } },
          { id: 8, filters: {} },
          rawDefinition({ key: 'unregistered_flag' }),
        ],
        group_type_mapping: {},
      },
      NONE,
      NOW
    )
    expect(snapshot.flags.broken_flag).toEqual({
      key: 'broken_flag',
      id: 7,
      active: true,
      unsupported: 'malformed',
      raw: NONE,
    })
    expect(snapshot.flags.unregistered_flag?.unsupported).toBeNull()
    expect(Object.keys(snapshot.flags)).toHaveLength(2)
  })

  it('stores a remote key such as __proto__ as an own property, never the prototype', () => {
    const snapshot = parseDefinitionsResponse(
      { flags: [rawDefinition({ key: '__proto__' })], group_type_mapping: {} },
      NONE,
      NOW
    )
    expect(Object.hasOwn(snapshot.flags, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(snapshot.flags)).toBe(Object.prototype)
  })

  it.each([
    ['a string', 'not json'],
    ['flags that are not a list', { flags: {}, group_type_mapping: {} }],
    [
      'a group_type_mapping that is not a record of strings',
      { flags: [], group_type_mapping: [1] },
    ],
  ])('throws on %s', (_label, body) => {
    expect(() => parseDefinitionsResponse(body, NONE, NOW)).toThrow()
  })
})

describe('detectUnsupported', () => {
  it('accepts a plain rollout, a payload, any evaluation_runtime and is_set', () => {
    expect(detectUnsupported(definition(), USER_ENTRY, 0)).toBeNull()
    expect(
      detectUnsupported(definition({}, { payloads: { true: '{"a":1}' } }), USER_ENTRY, 0)
    ).toBeNull()
    expect(
      detectUnsupported(definition({ evaluation_runtime: 'client' }), USER_ENTRY, 0)
    ).toBeNull()
    expect(
      detectUnsupported(
        withProperties([
          { key: 'tenant_role', type: 'person', operator: 'is_set', value: 'is_set' },
        ]),
        USER_ENTRY,
        0
      )
    ).toBeNull()
  })

  it('accepts every trait key, distinct_id and $group_key', () => {
    const personKeys = [
      'platform_role',
      'tenant_role',
      'app_env',
      'account_created_days',
      'distinct_id',
    ]
    for (const key of personKeys) {
      expect(
        detectUnsupported(
          withProperties([{ key, type: 'person', operator: 'exact', value: ['x'] }]),
          USER_ENTRY,
          0
        )
      ).toBeNull()
    }
    for (const key of ['tenant_created_days', '$group_key']) {
      const flag = definition(
        {},
        {
          aggregation_group_type_index: 0,
          groups: [
            {
              aggregation_group_type_index: 0,
              properties: [{ key, type: 'group', group_type_index: 0, operator: 'gt', value: '1' }],
              rollout_percentage: 100,
            },
          ],
        }
      )
      expect(detectUnsupported(flag, TENANT_ENTRY, 0)).toBeNull()
    }
  })

  it('refuses a cohort condition (dynamic and static cohorts alike)', () => {
    expect(
      detectUnsupported(
        withProperties([{ key: 'id', type: 'cohort', value: 614_654 }]),
        USER_ENTRY,
        0
      )
    ).toBe('cohort')
  })

  it('refuses a flag dependency', () => {
    expect(
      detectUnsupported(
        withProperties([
          {
            key: 'other_flag',
            type: 'flag',
            operator: 'flag_evaluates_to',
            value: true,
            dependency_chain: ['other_flag'],
          },
        ]),
        USER_ENTRY,
        0
      )
    ).toBe('flag_dependency')
  })

  it('refuses is_not_set, even on a key outside the traits', () => {
    expect(
      detectUnsupported(
        withProperties([
          { key: 'signup_date', type: 'person', operator: 'is_not_set', value: 'is_not_set' },
        ]),
        USER_ENTRY,
        0
      )
    ).toBe('is_not_set')
  })

  it.each([
    ['an app condition', { key: 'app', type: 'person', operator: 'exact', value: ['react'] }],
    ['an email condition', { key: 'email', type: 'person', operator: 'icontains', value: '@x' }],
    [
      'a person key that is a group trait',
      { key: 'tenant_created_days', type: 'person', value: '1' },
    ],
  ])('refuses %s as property_key', (_label, property) => {
    expect(detectUnsupported(withProperties([property]), USER_ENTRY, 0)).toBe('property_key')
  })

  it('refuses a group key outside the group traits as property_key', () => {
    const flag = definition(
      {},
      {
        aggregation_group_type_index: 0,
        groups: [
          {
            aggregation_group_type_index: 0,
            properties: [{ key: 'name', type: 'group', group_type_index: 0, value: 'Acme' }],
            rollout_percentage: 100,
          },
        ],
      }
    )
    expect(detectUnsupported(flag, TENANT_ENTRY, 0)).toBe('property_key')
  })

  it('refuses experience continuity', () => {
    expect(
      detectUnsupported(definition({ ensure_experience_continuity: true }), USER_ENTRY, 0)
    ).toBe('experience_continuity')
  })

  it('refuses early access, by feature_enrollment or by super_groups', () => {
    expect(detectUnsupported(definition({}, { feature_enrollment: true }), USER_ENTRY, 0)).toBe(
      'early_access'
    )
    expect(
      detectUnsupported(
        definition({}, { super_groups: [{ properties: [], rollout_percentage: 100 }] }),
        USER_ENTRY,
        0
      )
    ).toBe('early_access')
    expect(detectUnsupported(definition({}, { super_groups: [] }), USER_ENTRY, 0)).toBeNull()
  })

  it('refuses an aggregation index that is not the tenant index, or with no tenant group type', () => {
    expect(detectUnsupported(tenantDefinition(), TENANT_ENTRY, 1)).toBe('group_type')
    expect(detectUnsupported(tenantDefinition(), TENANT_ENTRY, NONE)).toBe('group_type')
  })

  it('refuses a condition whose aggregation differs from the flag', () => {
    expect(
      detectUnsupported(tenantDefinition({ aggregation_group_type_index: NONE }), TENANT_ENTRY, 0)
    ).toBe('group_type')
  })

  it('refuses a group property of another group type', () => {
    const flag = definition(
      {},
      {
        aggregation_group_type_index: 0,
        groups: [
          {
            aggregation_group_type_index: 0,
            properties: [
              { key: 'tenant_created_days', type: 'group', group_type_index: 3, value: '1' },
            ],
            rollout_percentage: 100,
          },
        ],
      }
    )
    expect(detectUnsupported(flag, TENANT_ENTRY, 0)).toBe('group_type')
  })

  it('refuses an aggregation that disagrees with the registry scope, both ways', () => {
    expect(detectUnsupported(tenantDefinition(), USER_ENTRY, 0)).toBe('scope_drift')
    expect(detectUnsupported(definition(), TENANT_ENTRY, 0)).toBe('scope_drift')
  })

  it('checks no scope or kind for a flag the registry does not declare', () => {
    expect(detectUnsupported(tenantDefinition(), undefined, 0)).toBeNull()
  })

  it('refuses a definition whose kind disagrees with the registry, both ways', () => {
    const multivariate = definition(
      {},
      {
        multivariate: {
          variants: [
            { key: 'control', rollout_percentage: 50 },
            { key: 'bold', rollout_percentage: 50 },
          ],
        },
      }
    )
    expect(detectUnsupported(multivariate, USER_ENTRY, 0)).toBe('kind_drift')
    expect(detectUnsupported(definition(), MULTIVARIATE_ENTRY, 0)).toBe('kind_drift')
    expect(detectUnsupported(multivariate, MULTIVARIATE_ENTRY, 0)).toBeNull()
  })

  it('refuses bucketing on anything but distinct_id', () => {
    expect(
      detectUnsupported(definition({ bucketing_identifier: 'device_id' }), USER_ENTRY, 0)
    ).toBe('bucketing_identifier')
  })

  it('refuses evaluation contexts', () => {
    expect(
      detectUnsupported(definition({ evaluation_contexts: ['checkout'] }), USER_ENTRY, 0)
    ).toBe('evaluation_contexts')
  })

  it('refuses an unknown property type', () => {
    expect(
      detectUnsupported(
        withProperties([{ key: 'platform_role', type: 'event', value: 'x' }]),
        USER_ENTRY,
        0
      )
    ).toBe('unknown_property_type')
  })

  it('refuses an unknown operator, and a negated property', () => {
    expect(
      detectUnsupported(
        withProperties([
          { key: 'platform_role', type: 'person', operator: 'in_cohort', value: 'x' },
        ]),
        USER_ENTRY,
        0
      )
    ).toBe('unknown_operator')
    expect(
      detectUnsupported(
        withProperties([
          {
            key: 'platform_role',
            type: 'person',
            operator: 'exact',
            value: ['admin'],
            negation: true,
          },
        ]),
        USER_ENTRY,
        0
      )
    ).toBe('unknown_operator')
  })

  it('refuses an unknown filters key', () => {
    expect(detectUnsupported(definition({}, { brand_new_rule: {} }), USER_ENTRY, 0)).toBe(
      'unknown_filter'
    )
  })

  it('refuses a condition variant that is not one of the flag variants', () => {
    const flag = definition(
      {},
      {
        groups: [
          {
            aggregation_group_type_index: NONE,
            properties: [],
            rollout_percentage: 100,
            variant: 'loud',
          },
        ],
        multivariate: {
          variants: [
            { key: 'control', rollout_percentage: 50 },
            { key: 'bold', rollout_percentage: 50 },
          ],
        },
      }
    )
    expect(detectUnsupported(flag, MULTIVARIATE_ENTRY, 0)).toBe('malformed')
  })

  it('accepts a NONE condition variant, as early-access flags carry', () => {
    const flag = definition(
      {},
      {
        groups: [
          {
            aggregation_group_type_index: NONE,
            properties: [],
            rollout_percentage: 0,
            variant: NONE,
          },
        ],
      }
    )
    expect(detectUnsupported(flag, USER_ENTRY, 0)).toBeNull()
  })

  it('marks the registered reference flags supported when PostHog holds what flags:sync creates', () => {
    const snapshot = parseDefinitionsResponse(
      {
        flags: [
          rawDefinition(
            { key: 'example_beta_page', active: false },
            {
              aggregation_group_type_index: 0,
              groups: [{ aggregation_group_type_index: 0, properties: [], rollout_percentage: 0 }],
            }
          ),
          rawDefinition(
            { key: 'example_cta_experiment', active: false },
            {
              groups: [
                { aggregation_group_type_index: NONE, properties: [], rollout_percentage: 0 },
              ],
              multivariate: {
                variants: [
                  { key: 'control', rollout_percentage: 50 },
                  { key: 'bold', rollout_percentage: 50 },
                ],
              },
            }
          ),
        ],
        group_type_mapping: { '0': 'tenant' },
      },
      NONE,
      NOW
    )
    expect(snapshot.flags.example_beta_page?.unsupported).toBeNull()
    expect(snapshot.flags.example_cta_experiment?.unsupported).toBeNull()
    expect(flagEntry('example_beta_page').scope).toBe('tenant')
  })
})
