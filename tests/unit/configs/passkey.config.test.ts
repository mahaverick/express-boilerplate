/**
 * @file The relying-party config takes the env as an argument, so every case
 * here is a crafted env, never the memoised getEnv().
 */
import { describe, expect, it } from 'vitest'
import { isPasskeyEnabled, passkeyRelyingParty } from '@/configs/passkey.config'

describe('passkeyRelyingParty', () => {
  it("defaults the RP ID to WEB_URL's host and lists WEB_URL alone without APEX_URL", () => {
    expect(passkeyRelyingParty({ WEB_URL: 'http://localhost:5173', APP_NAME: 'Acme' })).toEqual({
      rpId: 'localhost',
      rpName: 'Acme',
      origins: ['http://localhost:5173'],
    })
  })

  it('adds APEX_URL to the origins and keeps an explicit RP ID', () => {
    const relyingParty = passkeyRelyingParty({
      WEB_URL: 'https://domain.com',
      APEX_URL: 'https://apex.domain.com',
      WEBAUTHN_RP_ID: 'domain.com',
      APP_NAME: 'Acme',
    })
    expect(relyingParty.rpId).toBe('domain.com')
    expect(relyingParty.origins).toEqual(['https://domain.com', 'https://apex.domain.com'])
  })

  it('lists origins without a path or trailing slash', () => {
    expect(
      passkeyRelyingParty({ WEB_URL: 'https://domain.com/', APP_NAME: 'Acme' }).origins
    ).toEqual(['https://domain.com'])
  })
})

describe('isPasskeyEnabled', () => {
  it('is false only when the mode is off', () => {
    expect(isPasskeyEnabled({ PASSKEY_MODE: 'off' })).toBe(false)
    expect(isPasskeyEnabled({ PASSKEY_MODE: 'optional' })).toBe(true)
    expect(isPasskeyEnabled({ PASSKEY_MODE: 'required' })).toBe(true)
  })
})
