/**
 * @file `passkeyProvider` names a passkey's provider from its AAGUID, and
 * falls back to "Passkey" with no icons for one the list does not know.
 */
import { describe, expect, it } from 'vitest'
import { passkeyProvider } from '@/services/passkey-provider.service'

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
