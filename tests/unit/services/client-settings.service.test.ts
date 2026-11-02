/**
 * @file `clientSettingsFrom`: the link lifetimes in whole seconds and the
 * support address, read from the environment it is given, so a deployment
 * that changes a lifetime changes what the apps say.
 */
import { describe, expect, it } from 'vite-plus/test'
import { clientSettingsFrom } from '@/services/client-settings.service'

describe('clientSettingsFrom', () => {
  it('answers each lifetime in whole seconds and SUPPORT_EMAIL when it is set', () => {
    expect(
      clientSettingsFrom({
        SIGN_IN_LINK_TTL: '20m',
        STEP_UP_LINK_TTL: '25m',
        INVITATION_TTL: '5d',
        SUPPORT_EMAIL: 'support@test.example',
        MAIL_FROM: 'hello@example.net',
      })
    ).toStrictEqual({
      signInLinkTtlSeconds: 1200,
      stepUpLinkTtlSeconds: 1500,
      invitationTtlSeconds: 432_000,
      supportEmail: 'support@test.example',
    })
  })

  it("names support@ on MAIL_FROM's domain while SUPPORT_EMAIL is unset", () => {
    expect(
      clientSettingsFrom({
        SIGN_IN_LINK_TTL: '15m',
        STEP_UP_LINK_TTL: '15m',
        INVITATION_TTL: '3d',
        MAIL_FROM: 'hello@Mail.Example.NET',
      }).supportEmail
    ).toBe('support@mail.example.net')
  })

  it('rounds a lifetime with a millisecond remainder down to whole seconds', () => {
    expect(
      clientSettingsFrom({
        SIGN_IN_LINK_TTL: '90500',
        STEP_UP_LINK_TTL: '15m',
        INVITATION_TTL: '3d',
        MAIL_FROM: 'hello@example.net',
      }).signInLinkTtlSeconds
    ).toBe(90)
  })
})
