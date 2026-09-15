// tests/unit/configs/mailer.config.test.ts
//
// `mailTransportOptions` is unit-tested directly, with a hand-built env
// slice, rather than through `getMailTransporter()` — `getMailTransporter`
// calls the memoised `getEnv()` (env.config.ts), so once any test in this
// worker has called it, SMTP_USER/SMTP_PASS can never be varied between
// cases again. Same reasoning `trustProxySetting` (env.config.ts) is
// unit-tested as a pure function rather than through `getEnv()`.
import { describe, expect, it } from 'vitest'
import { getMailTransporter, mailTransportOptions, requiresTls } from '@/configs/mailer.config'

const baseEnv = {
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
}

describe('mailTransportOptions', () => {
  it('carries host and port through unchanged', () => {
    const options = mailTransportOptions({
      ...baseEnv,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
    })
    expect(options.host).toBe('smtp.example.com')
    expect(options.port).toBe(587)
  })

  it('omits `auth` entirely when neither SMTP_USER nor SMTP_PASS is set — Mailpit needs none', () => {
    const options = mailTransportOptions(baseEnv)
    expect(options.auth).toBeUndefined()
  })

  it('builds `auth` when both SMTP_USER and SMTP_PASS are set', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_USER: 'apikey', SMTP_PASS: 'secret' })
    expect(options.auth).toEqual({ user: 'apikey', pass: 'secret' })
  })

  // A real footgun, not a hypothetical one: a provider that silently drops
  // auth for a half-set credential pair fails at the first real send, as an
  // opaque authentication error, instead of at boot as a configuration one.
  // This test pins the actual (safe) behaviour — no auth attempted, same as
  // neither being set — since a schema-level both-or-neither refinement is
  // not available here (see env.config.ts's own comment on why).
  it('omits `auth` when only SMTP_USER is set, without throwing', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_USER: 'apikey' })
    expect(options.auth).toBeUndefined()
  })

  it('omits `auth` when only SMTP_PASS is set, without throwing', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_PASS: 'secret' })
    expect(options.auth).toBeUndefined()
  })
})

describe('requiresTls', () => {
  // Keyed on NODE_ENV, not SMTP_HOST — see this function's own comment
  // (mailer.config.ts) for why a host-name check is the wrong footgun here.
  // Mirrors isSecureCookieEnvironment's identical NODE_ENV-keyed decision
  // (auth.controller.ts). Unit-tested directly, with a hand-built env slice,
  // for the same reason mailTransportOptions is: getMailTransporter reads
  // the memoised getEnv() exactly once per worker, so this decision cannot
  // otherwise be exercised for both branches in one test run.
  it('is false outside production', () => {
    expect(requiresTls({ NODE_ENV: 'development' })).toBe(false)
    expect(requiresTls({ NODE_ENV: 'test' })).toBe(false)
  })

  it('is true in production', () => {
    expect(requiresTls({ NODE_ENV: 'production' })).toBe(true)
  })
})

describe('getMailTransporter', () => {
  it('memoises: repeated calls return the same transporter instance', () => {
    expect(getMailTransporter()).toBe(getMailTransporter())
  })

  // .env.test sets NODE_ENV=test, so the real, memoised transporter this
  // process builds must not require TLS — confirms requiresTls is actually
  // wired into the createTransport call, not just correct in isolation.
  it('does not require TLS in this (test) process', () => {
    const options = getMailTransporter().options as { requireTLS?: boolean }
    expect(options.requireTLS).toBe(false)
  })
})
