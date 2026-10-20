/**
 * @file `passkeyProvider` names a passkey's provider from its AAGUID, and
 * falls back to "Passkey" with no icons for one the list does not know.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPasskeyProviderLookup, passkeyProvider } from '@/services/passkey-provider.service'
import { dedupeAaguids, MAX_ICON_LENGTH } from '../../../scripts/vendor-passkey-aaguids.mjs'

describe('passkeyProvider', () => {
  it('names a listed AAGUID and carries its icons', () => {
    const provider = passkeyProvider('fbfc3007-154e-4ecc-8c0b-6e020557d7bd')
    expect(provider.name).toBe('Apple Passwords')
    expect(provider.iconLight).toMatch(/^data:image\//)
    expect(provider.iconDark).toMatch(/^data:image\//)
  })

  it('matches an AAGUID in any letter case', () => {
    expect(passkeyProvider('FBFC3007-154E-4ECC-8C0B-6E020557D7BD').name).toBe('Apple Passwords')
  })

  it('falls back to Passkey for an unknown AAGUID', () => {
    expect(passkeyProvider('00000000-0000-0000-0000-000000000000')).toEqual({
      name: 'Passkey',
      // eslint-disable-next-line unicorn/no-null -- the API's "no icon" value
      iconLight: null,
      // eslint-disable-next-line unicorn/no-null -- the API's "no icon" value
      iconDark: null,
    })
  })

  it('does not read inherited object keys as AAGUIDs', () => {
    expect(passkeyProvider('constructor').name).toBe('Passkey')
    expect(passkeyProvider('__proto__').name).toBe('Passkey')
  })
})

describe('createPasskeyProviderLookup', () => {
  const source = { repo: 'r', commit: 'c', fetchedAt: '2026-10-20' }

  it('maps an oversized icon to null and keeps a small one', () => {
    const data = dedupeAaguids(
      {
        'aaaaaaaa-0000-0000-0000-000000000001': {
          name: 'Big',
          icon_light: `data:image/png;base64,${'A'.repeat(MAX_ICON_LENGTH)}`,
          icon_dark: 'data:image/png;base64,AAAA',
        },
      },
      source
    )
    const provider = createPasskeyProviderLookup(data)('aaaaaaaa-0000-0000-0000-000000000001')
    expect(provider).toEqual({
      name: 'Big',
      // eslint-disable-next-line unicorn/no-null -- the API's "no icon" value
      iconLight: null,
      iconDark: 'data:image/png;base64,AAAA',
    })
  })

  it('stores a repeated icon once', () => {
    const icon = 'data:image/png;base64,AAAA'
    const data = dedupeAaguids(
      {
        a: { name: 'A', icon_light: icon, icon_dark: icon },
        b: { name: 'B', icon_light: icon },
      },
      source
    )
    expect(data.icons).toEqual([icon])
  })

  it('refuses data of the wrong shape or with a bad icon index', () => {
    expect(() => createPasskeyProviderLookup({ entries: {} })).toThrow()
    expect(() =>
      createPasskeyProviderLookup({
        source,
        icons: [],
        entries: { x: { name: 'X', light: 3, dark: undefined } },
      })
    ).toThrow()
    expect(() =>
      createPasskeyProviderLookup({
        source,
        icons: [],
        // eslint-disable-next-line unicorn/no-null -- the stored "no icon" value
        entries: { x: { name: 'X', light: 3, dark: null } },
      })
    ).toThrow(/out of range/)
  })

  it('reads the data file with fs, not a JSON import', () => {
    const text = readFileSync(
      new URL('../../../src/services/passkey-provider.service.ts', import.meta.url),
      'utf8'
    )
    expect(text).toContain('readFileSync(new URL(')
    expect(text).not.toMatch(/^import .* from '.*\.json'/m)
  })
})
