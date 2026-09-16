// tests/unit/configs/mailer.config.test.ts
//
// `mailTransportOptions` is unit-tested directly, with a hand-built env
// slice, rather than through `getMailTransporter()` — `getMailTransporter`
// calls the memoised `getEnv()` (env.config.ts), so once any test in this
// worker has called it, SMTP_USER/SMTP_PASS can never be varied between
// cases again. Same reasoning `trustProxySetting` (env.config.ts) is
// unit-tested as a pure function rather than through `getEnv()`.
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '@/configs/env.config'
import { getMailTransporter, mailTransportOptions, requiresTls } from '@/configs/mailer.config'
import { withMutatedModule } from '../../helpers/mutate'

const baseEnv = {
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  SMTP_CONNECTION_TIMEOUT: 5000,
  SMTP_GREETING_TIMEOUT: 5000,
  SMTP_SOCKET_TIMEOUT: 10_000,
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

  // Fix round 2 (task-2-review.md, finding 2): these bound a TIMING oracle
  // (Ruling G reopened through latency, not status) — see
  // SMTP_CONNECTION_TIMEOUT's own comment (env.config.ts). Pinned here so
  // nothing can silently stop wiring them into the options nodemailer
  // actually receives.
  it('always sets connectionTimeout/greetingTimeout/socketTimeout, never left to nodemailer defaults', () => {
    const options = mailTransportOptions({
      ...baseEnv,
      SMTP_CONNECTION_TIMEOUT: 1234,
      SMTP_GREETING_TIMEOUT: 2345,
      SMTP_SOCKET_TIMEOUT: 3456,
    })
    expect(options.connectionTimeout).toBe(1234)
    expect(options.greetingTimeout).toBe(2345)
    expect(options.socketTimeout).toBe(3456)
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

// Fix round 2 (task-2-review.md, finding 9): a half-set SMTP_USER/SMTP_PASS
// pair sends unauthenticated in production and nothing says why — restore
// the boot-time signal. `getMailTransporter` reads the memoised `getEnv()`
// exactly once per worker (same constraint `requiresTls`'s own tests are
// built around), so exercising this specific env shape needs a fresh module
// instance — `withMutatedModule` mocks `@/configs/env.config` and reloads
// `@/configs/mailer.config` against it, the intended use of that helper
// (mailer.config.ts has no shared prototype method `withMutatedMethod`
// could reach instead).
describe('getMailTransporter — half-set credential warning', () => {
  const halfSetUserOnlyEnv: Env = {
    NODE_ENV: 'test',
    APP_PORT: 4040,
    APP_URL: 'http://localhost:4040',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    SESSION_SECRET: 'b'.repeat(32),
    ACCESS_TOKEN_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
    SESSION_ABSOLUTE_TTL: '30d',
    EMAIL_VERIFICATION_TTL: '24h',
    TRUST_PROXY: 'false',
    LOG_LEVEL: 'info',
    SLACK_LOG_LEVEL: 'error',
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: 'only-the-username-is-set',
    SMTP_PASS: undefined,
    MAIL_FROM: 'no-reply@example.com',
    APP_NAME: 'Test App',
    SMTP_CONNECTION_TIMEOUT: 5000,
    SMTP_GREETING_TIMEOUT: 5000,
    SMTP_SOCKET_TIMEOUT: 10_000,
  }

  it('warns when exactly one of SMTP_USER/SMTP_PASS is set', async () => {
    // vi.spyOn on a FRESH `logger` module instance, not the one imported at
    // the top of this file: withMutatedModule calls vi.resetModules()
    // before loadSubject runs, which discards this worker's entire module
    // cache — the freshly (re)loaded mailer.config below therefore resolves
    // its own `import { logger } from '@/services/logger.service'` against
    // a NEW module namespace object, distinct from the one this file
    // already imported. Spying on the top-level `logger` would watch a
    // different object than the one mailer.config actually calls, and the
    // assertion below would see zero calls. Loading logger.service.ts
    // yourself, after the reset, inside loadSubject, is what makes the spy
    // and the call land on the same instance.
    await withMutatedModule(
      '@/configs/env.config',
      { getEnv: () => halfSetUserOnlyEnv },
      async () => ({
        mailerConfig: await import('@/configs/mailer.config'),
        loggerService: await import('@/services/logger.service'),
      }),
      ({ mailerConfig, loggerService }) => {
        const warnSpy = vi.spyOn(loggerService.logger, 'warn').mockImplementation(() => {})
        try {
          mailerConfig.getMailTransporter()

          expect(warnSpy).toHaveBeenCalledTimes(1)
          const [message] = warnSpy.mock.calls[0] ?? []
          expect(message).toContain('SMTP_USER')
          expect(message).toContain('SMTP_PASS')
        } finally {
          warnSpy.mockRestore()
        }
      }
    )
  })

  it('does not warn when both SMTP_USER and SMTP_PASS are set', async () => {
    const bothSetEnv: Env = {
      ...halfSetUserOnlyEnv,
      SMTP_USER: 'apikey',
      SMTP_PASS: 'secret',
    }
    await withMutatedModule(
      '@/configs/env.config',
      { getEnv: () => bothSetEnv },
      async () => ({
        mailerConfig: await import('@/configs/mailer.config'),
        loggerService: await import('@/services/logger.service'),
      }),
      ({ mailerConfig, loggerService }) => {
        const warnSpy = vi.spyOn(loggerService.logger, 'warn').mockImplementation(() => {})
        try {
          mailerConfig.getMailTransporter()

          expect(warnSpy).not.toHaveBeenCalled()
        } finally {
          warnSpy.mockRestore()
        }
      }
    )
  })
})
