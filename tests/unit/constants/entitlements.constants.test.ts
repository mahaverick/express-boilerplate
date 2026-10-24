/**
 * @file The entitlement registry holds well-formed entries and a catalog that lists them.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  ENTITLEMENTS,
  entitlementCatalog,
  type EntitlementKey,
} from '@/constants/entitlements.constants'

describe('ENTITLEMENTS', () => {
  it('gives every limit a numeric or null default and every feature a boolean default', () => {
    for (const definition of Object.values(ENTITLEMENTS)) {
      for (const value of Object.values(definition.defaults)) {
        if (definition.kind === 'limit') {
          expect(value === null || typeof value === 'number').toBe(true)
        } else {
          expect(typeof value).toBe('boolean')
        }
      }
    }
  })

  it('keeps a soft threshold between 0 and 1 on limits only', () => {
    for (const definition of Object.values(ENTITLEMENTS)) {
      if (!('softAt' in definition)) continue
      expect(definition.kind).toBe('limit')
      expect(definition.softAt).toBeGreaterThan(0)
      expect(definition.softAt).toBeLessThan(1)
    }
  })
})

describe('entitlementCatalog', () => {
  it('lists members and advanced_example with their labels', () => {
    const catalog = entitlementCatalog()
    const keys: EntitlementKey[] = catalog.map(({ key }) => key)
    expect(keys).toEqual(Object.keys(ENTITLEMENTS))
    expect(catalog.map(({ key, label }) => [key, label])).toEqual([
      ['members', 'Members'],
      ['advanced_example', 'Workspace insights'],
    ])
  })

  it('carries each definition beside its key', () => {
    expect(entitlementCatalog()[0]).toMatchObject({
      key: 'members',
      kind: 'limit',
      defaults: { free: 3, paid: null },
      softAt: 0.8,
    })
  })
})
