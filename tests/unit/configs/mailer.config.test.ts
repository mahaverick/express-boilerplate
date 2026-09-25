// tests/unit/configs/mailer.config.test.ts
//
// `mailTransportOptions` is unit-tested directly, with a hand-built env
// slice, rather than through `getMailTransporter()` — `getMailTransporter`
// calls the memoised `getEnv()` (env.config.ts), so once any test in this
// worker has called it, SMTP_USERNAME/SMTP_PASSWORD can never be varied
// between cases again. Same reasoning `trustProxySetting` (env.config.ts) is
// unit-tested as a pure function rather than through `getEnv()`.
import { describe, expect, it } from 'vitest'
import { getEnv, type Env } from '@/configs/env.config'
import { getMailTransporter, mailTransportOptions } from '@/configs/mailer.config'
import { withMutatedModule } from '../../helpers/mutate'

const baseEnv = {
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  SMTP_USERNAME: undefined,
  SMTP_PASSWORD: undefined,
  SMTP_CONNECTION_TIMEOUT_MS: 5000,
  SMTP_GREETING_TIMEOUT_MS: 5000,
  SMTP_SOCKET_TIMEOUT_MS: 10_000,
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

  it('omits `auth` entirely when neither SMTP_USERNAME nor SMTP_PASSWORD is set — Mailpit needs none', () => {
    const options = mailTransportOptions(baseEnv)
    expect(options.auth).toBeUndefined()
  })

  it('builds `auth` when both SMTP_USERNAME and SMTP_PASSWORD are set', () => {
    const options = mailTransportOptions({
      ...baseEnv,
      SMTP_USERNAME: 'apikey',
      SMTP_PASSWORD: 'secret',
    })
    expect(options.auth).toEqual({ user: 'apikey', pass: 'secret' })
  })

  // A half-set pair attempts no auth here, the same as neither being set.
  // Refusing that configuration is a boot check's job, not this builder's.
  it('omits `auth` when only SMTP_USERNAME is set, without throwing', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_USERNAME: 'apikey' })
    expect(options.auth).toBeUndefined()
  })

  it('omits `auth` when only SMTP_PASSWORD is set, without throwing', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_PASSWORD: 'secret' })
    expect(options.auth).toBeUndefined()
  })

  // These bound each stage of a send to a host that stops responding
  // (env.config.ts's comment on the SMTP timeout group), so they must always
  // reach nodemailer, never its own defaults.
  it('always sets connectionTimeout/greetingTimeout/socketTimeout from the _MS variables', () => {
    const options = mailTransportOptions({
      ...baseEnv,
      SMTP_CONNECTION_TIMEOUT_MS: 1234,
      SMTP_GREETING_TIMEOUT_MS: 2345,
      SMTP_SOCKET_TIMEOUT_MS: 3456,
    })
    expect(options.connectionTimeout).toBe(1234)
    expect(options.greetingTimeout).toBe(2345)
    expect(options.socketTimeout).toBe(3456)
  })

  // nodemailer's own DNS query timeout is 30 seconds, longer than the whole
  // default shutdown budget.
  it('sets dnsTimeout from SMTP_CONNECTION_TIMEOUT_MS', () => {
    const options = mailTransportOptions({ ...baseEnv, SMTP_CONNECTION_TIMEOUT_MS: 1234 })
    expect(options.dnsTimeout).toBe(1234)
  })
})

describe('getMailTransporter', () => {
  it('memoises: repeated calls return the same transporter instance', () => {
    expect(getMailTransporter()).toBe(getMailTransporter())
  })

  // .env.test sets APP_ENV=local, so the real, memoised transporter this
  // process builds must not require TLS.
  it('does not require TLS in this (APP_ENV=local) process', () => {
    const options = getMailTransporter().options as { requireTLS?: boolean }
    expect(options.requireTLS).toBe(false)
  })

  // getMailTransporter reads the memoised getEnv() once per worker, so the
  // non-local branch needs a fresh module instance against a mutated env.
  it('requires TLS outside local, proving requiresSmtpTls is wired in', async () => {
    const productionEnv: Env = { ...getEnv(), APP_ENV: 'prod' }
    await withMutatedModule(
      '@/configs/env.config',
      { getEnv: () => productionEnv },
      () => import('@/configs/mailer.config'),
      (mailerConfig) => {
        const options = mailerConfig.getMailTransporter().options as { requireTLS?: boolean }
        expect(options.requireTLS).toBe(true)
      }
    )
  })
})
