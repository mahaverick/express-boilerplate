/**
 * @file The flag registry's load-time check, one case per rule, the two
 * reference entries, the client slices, the trait set, and the types the
 * registry derives (an unregistered key is a type error).
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertFlagRegistry,
  clientFlagsFor,
  findFlagEntry,
  FLAG_GROUP_PROPERTY_KEYS,
  FLAG_KEY_MAX,
  FLAG_PERSON_PROPERTY_KEYS,
  FLAG_TRAITS,
  flagEntry,
  FLAGS,
  type BooleanFlagKey,
  type FlagEntry,
  type FlagKey,
  type MultivariateFlagKey,
  type VariantOf,
} from '@/constants/flags.constants'

const BOOLEAN: FlagEntry = {
  key: 'some_flag',
  description: 'A flag',
  kind: 'boolean',
  fallback: false,
  scope: 'user',
  client: false,
  apps: [],
  experiment: false,
}

const EXPERIMENT: FlagEntry = {
  key: 'some_experiment',
  description: 'An experiment',
  kind: 'multivariate',
  variants: ['control', 'bold'],
  fallback: 'control',
  scope: 'user',
  client: true,
  apps: ['react'],
  experiment: true,
}

/**
 * Run the registry check on one changed copy of an entry.
 * @param entry - The entry, with the field under test changed.
 * @returns A function that runs the check, for `toThrow`.
 */
function checking(entry: Record<string, unknown>): () => unknown {
  return () => assertFlagRegistry([entry as unknown as FlagEntry])
}

describe('assertFlagRegistry', () => {
  it('returns a valid registry unchanged', () => {
    const entries = [BOOLEAN, EXPERIMENT] as const
    expect(assertFlagRegistry(entries)).toBe(entries)
  })

  it.each(['Some_flag', '1flag', 'some-flag', 'some flag', ''])(
    'refuses the key %j, which is not snake_case',
    (key) => {
      expect(checking({ ...BOOLEAN, key })).toThrow(/snake_case/)
    }
  )

  it('refuses a key longer than FLAG_KEY_MAX characters and accepts one exactly that long', () => {
    expect(checking({ ...BOOLEAN, key: 'a'.repeat(FLAG_KEY_MAX + 1) })).toThrow(/64 characters/)
    expect(checking({ ...BOOLEAN, key: 'a'.repeat(FLAG_KEY_MAX) })).not.toThrow()
  })

  it('refuses a duplicate key', () => {
    expect(() => assertFlagRegistry([BOOLEAN, { ...BOOLEAN }])).toThrow(/duplicate key some_flag/)
  })

  it('refuses a boolean flag whose fallback is not false', () => {
    expect(checking({ ...BOOLEAN, fallback: true })).toThrow(/fall back to false/)
  })

  it('refuses an empty variants list', () => {
    expect(checking({ ...EXPERIMENT, variants: [], experiment: false })).toThrow(/no variants/)
  })

  it('refuses duplicate variants', () => {
    expect(checking({ ...EXPERIMENT, variants: ['control', 'control'] })).toThrow(
      /duplicate variant control/
    )
  })

  it('refuses a fallback that is not in variants', () => {
    expect(checking({ ...EXPERIMENT, fallback: 'other' })).toThrow(/fall back to variants\[0\]/)
  })

  it('refuses a fallback that is a variant but not variants[0]', () => {
    expect(checking({ ...EXPERIMENT, fallback: 'bold' })).toThrow(/fall back to variants\[0\]/)
  })

  it('refuses a client flag with no apps', () => {
    expect(checking({ ...EXPERIMENT, apps: [] })).toThrow(/apps exactly when client/)
  })

  it('refuses apps on a flag that is not client', () => {
    expect(checking({ ...BOOLEAN, apps: ['react'] })).toThrow(/apps exactly when client/)
  })

  it('refuses an experiment that is boolean, since boolean exposure is not counted', () => {
    expect(checking({ ...BOOLEAN, experiment: true })).toThrow(/experiment must be multivariate/)
  })

  it("refuses an experiment whose variants[0] is not 'control'", () => {
    expect(checking({ ...EXPERIMENT, variants: ['bold', 'control'], fallback: 'bold' })).toThrow(
      /variants\[0\] must be 'control'/
    )
  })

  it('accepts a server-only experiment', () => {
    expect(checking({ ...EXPERIMENT, client: false, apps: [] })).not.toThrow()
  })
})

describe('FLAGS', () => {
  it('holds the two reference flags', () => {
    expect(FLAGS).toEqual([
      {
        key: 'example_beta_page',
        description: 'Reference flag: the tenant Beta page and its API route',
        kind: 'boolean',
        fallback: false,
        scope: 'tenant',
        client: true,
        apps: ['react'],
        experiment: false,
      },
      {
        key: 'example_cta_experiment',
        description: 'Reference experiment: the getting-started call-to-action style',
        kind: 'multivariate',
        variants: ['control', 'bold'],
        fallback: 'control',
        scope: 'user',
        client: true,
        apps: ['react'],
        experiment: true,
      },
    ])
  })

  it('looks an entry up by key', () => {
    expect(flagEntry('example_beta_page').kind).toBe('boolean')
    expect(findFlagEntry('example_cta_experiment')?.kind).toBe('multivariate')
    expect(findFlagEntry('not_registered')).toBeUndefined()
  })

  it('throws for a key that is not registered, which only an untyped caller can pass', () => {
    expect(() => flagEntry('not_registered' as FlagKey)).toThrow(/not_registered/)
  })

  it('gives each app only its client flags', () => {
    expect(clientFlagsFor('react').map((entry) => entry.key)).toEqual([
      'example_beta_page',
      'example_cta_experiment',
    ])
    expect(clientFlagsFor('apex')).toEqual([])
  })

  it('derives the key and variant types from the entries', () => {
    expectTypeOf<FlagKey>().toEqualTypeOf<'example_beta_page' | 'example_cta_experiment'>()
    expectTypeOf<BooleanFlagKey>().toEqualTypeOf<'example_beta_page'>()
    expectTypeOf<MultivariateFlagKey>().toEqualTypeOf<'example_cta_experiment'>()
    expectTypeOf<VariantOf<'example_cta_experiment'>>().toEqualTypeOf<'control' | 'bold'>()
    // @ts-expect-error an unregistered key is not a FlagKey
    expectTypeOf<VariantOf<'not_registered'>>().toBeNever()
  })
})

describe('FLAG_TRAITS', () => {
  it('is the closed set of five traits, with no app trait', () => {
    expect(FLAG_TRAITS.map((trait) => [trait.name, trait.where])).toEqual([
      ['platform_role', 'person'],
      ['tenant_role', 'person'],
      ['app_env', 'person'],
      ['account_created_days', 'person'],
      ['tenant_created_days', 'group'],
    ])
    for (const trait of FLAG_TRAITS) {
      expect(trait.description.length).toBeGreaterThan(0)
      expect(trait.examples.length).toBeGreaterThan(0)
    }
  })

  it('allows the person traits plus distinct_id, and the group traits plus $group_key', () => {
    expect([...FLAG_PERSON_PROPERTY_KEYS]).toEqual([
      'platform_role',
      'tenant_role',
      'app_env',
      'account_created_days',
      'distinct_id',
    ])
    expect([...FLAG_GROUP_PROPERTY_KEYS]).toEqual(['tenant_created_days', '$group_key'])
  })
})
