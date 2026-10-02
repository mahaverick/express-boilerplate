/**
 * @file assertEnvConsistent takes the env, the raw source and the warn
 * sink as arguments, so every case here is a crafted env, never the
 * memoised getEnv().
 */
import { describe, expect, it, vi } from 'vitest'
import { assertEnvConsistent, REMOVED_ENV_NAMES } from '@/configs/env-consistency.config'
import { parseEnv } from '@/configs/env.config'

const local: Record<string, string> = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
}

// A deployed environment with every Mailpit default replaced.
const deployed: Record<string, string> = {
  ...local,
  APP_ENV: 'prod',
  NODE_ENV: 'production',
  SMTP_HOST: 'smtp.example.net',
  SMTP_PORT: '587',
  MAIL_FROM: 'hello@example.net',
  MAIL_FROM_TRANSACTIONAL: 'auth@mail.example.net',
  TRUST_PROXY: '1',
}

/**
 * Run the boot checks against a crafted environment.
 * @param source - Raw variables, parsed with parseEnv first.
 * @param raw - The raw source the renamed-name check reads; defaults to `source`.
 * @returns The thrown message, if any, and every warning.
 */
function runChecks(
  source: Record<string, string>,
  raw: Record<string, string> = source
): { error: string | undefined; warnings: string[] } {
  const warn = vi.fn<(message: string) => void>()
  let message: string | undefined
  try {
    assertEnvConsistent(parseEnv(source), raw, warn)
  } catch (error) {
    message = (error as Error).message
  }
  return { error: message, warnings: warn.mock.calls.map(([warning]) => warning) }
}

describe('assertEnvConsistent', () => {
  describe('Google sign-in from Apex on another host', () => {
    const google = {
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      APP_URL: 'https://app.example.com',
      WEB_URL: 'https://app.example.com',
    }

    it('refuses boot when APEX_URL is another host and COOKIE_DOMAIN is unset', () => {
      const { error } = runChecks({ ...deployed, ...google, APEX_URL: 'https://admin.example.com' })
      expect(error).toContain("APEX_URL's host admin.example.com")
      expect(error).toContain('COOKIE_DOMAIN')
    })

    it('refuses boot when COOKIE_DOMAIN does not cover the Apex host', () => {
      const { error } = runChecks({
        ...deployed,
        ...google,
        APP_URL: 'https://app.example.com',
        APEX_URL: 'https://admin.other.example',
        COOKIE_DOMAIN: 'example.com',
      })
      expect(error).toContain("APEX_URL's host admin.other.example")
    })

    it('passes when COOKIE_DOMAIN covers both hosts', () => {
      const result = runChecks({
        ...deployed,
        ...google,
        APEX_URL: 'https://admin.example.com',
        COOKIE_DOMAIN: 'example.com',
      })
      expect(result.error).toBeUndefined()
    })

    it('passes when COOKIE_DOMAIN has a leading dot and covers the Apex host', () => {
      const result = runChecks({
        ...deployed,
        ...google,
        APEX_URL: 'https://admin.example.com',
        COOKIE_DOMAIN: '.example.com',
      })
      expect(result.error).toBeUndefined()
    })

    it('compares hosts and COOKIE_DOMAIN ignoring case', () => {
      const result = runChecks({
        ...deployed,
        ...google,
        APEX_URL: 'https://Admin.Example.COM',
        COOKIE_DOMAIN: '.EXAMPLE.com',
      })
      expect(result.error).toBeUndefined()
    })

    it('refuses a leading-dot COOKIE_DOMAIN that does not cover the Apex host', () => {
      const { error } = runChecks({
        ...deployed,
        ...google,
        APEX_URL: 'https://admin.other.example',
        COOKIE_DOMAIN: '.example.com',
      })
      expect(error).toContain("APEX_URL's host admin.other.example")
    })

    it('passes when Apex shares APP_URL’s host', () => {
      const result = runChecks({
        ...deployed,
        ...google,
        APEX_URL: 'https://app.example.com/admin',
      })
      expect(result.error).toBeUndefined()
    })

    it('passes when Google sign-in is off, whatever the hosts', () => {
      const result = runChecks({ ...deployed, APEX_URL: 'https://admin.example.com' })
      expect(result.error).toBeUndefined()
    })

    it('passes locally, where every origin is localhost', () => {
      const result = runChecks({
        ...local,
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        APEX_URL: 'http://localhost:5174',
      })
      expect(result.error).toBeUndefined()
    })
  })

  it('passes a local environment on every default, with no warning', () => {
    expect(runChecks(local)).toEqual({ error: undefined, warnings: [] })
  })

  it.each(['dev', 'qa', 'prod'])('passes a complete %s environment, with no warning', (appEnv) => {
    expect(runChecks({ ...deployed, APP_ENV: appEnv })).toEqual({ error: undefined, warnings: [] })
  })

  describe('renamed variables', () => {
    it.each(Object.entries(REMOVED_ENV_NAMES))('refuses %s, naming %s', (oldName, newName) => {
      const { error } = runChecks(local, { ...local, [oldName]: '1' })
      expect(error).toContain(`${oldName} was renamed to ${newName}`)
    })

    it('maps exactly the six renames of this release', () => {
      expect(REMOVED_ENV_NAMES).toEqual({
        SMTP_USER: 'SMTP_USERNAME',
        SMTP_PASS: 'SMTP_PASSWORD',
        SMTP_CONNECTION_TIMEOUT: 'SMTP_CONNECTION_TIMEOUT_MS',
        SMTP_GREETING_TIMEOUT: 'SMTP_GREETING_TIMEOUT_MS',
        SMTP_SOCKET_TIMEOUT: 'SMTP_SOCKET_TIMEOUT_MS',
        QUEUE_PREFIX: 'REDIS_KEY_PREFIX',
      })
    })

    it('ignores an old name set to an empty value, as parseEnv does', () => {
      expect(runChecks(local, { ...local, QUEUE_PREFIX: '' }).error).toBeUndefined()
    })
  })

  describe('NODE_ENV outside local', () => {
    it.each([
      { appEnv: 'dev', nodeEnv: 'development' },
      { appEnv: 'qa', nodeEnv: 'test' },
      { appEnv: 'prod', nodeEnv: 'development' },
    ])('refuses NODE_ENV=$nodeEnv on APP_ENV=$appEnv', ({ appEnv, nodeEnv }) => {
      const { error } = runChecks({ ...deployed, APP_ENV: appEnv, NODE_ENV: nodeEnv })
      expect(error).toContain(`NODE_ENV is ${nodeEnv}, but APP_ENV is ${appEnv}`)
    })

    it('allows NODE_ENV=development on local', () => {
      expect(runChecks({ ...local, NODE_ENV: 'development' }).error).toBeUndefined()
    })
  })

  describe('Mailpit defaults outside local', () => {
    it.each([
      { key: 'SMTP_HOST', value: 'localhost' },
      { key: 'SMTP_HOST', value: '127.0.0.1' },
      { key: 'SMTP_PORT', value: '1025' },
      { key: 'MAIL_FROM', value: 'no-reply@example.com' },
      { key: 'MAIL_FROM_TRANSACTIONAL', value: 'no-reply@example.com' },
    ])('refuses $key=$value on prod', ({ key, value }) => {
      const { error } = runChecks({ ...deployed, [key]: value })
      expect(error).toContain(`${key} is ${value}`)
    })

    it('reports every default at once when none was replaced', () => {
      const { error } = runChecks({ ...local, APP_ENV: 'qa', NODE_ENV: 'production' })
      expect(error).toContain('SMTP_HOST is 127.0.0.1')
      expect(error).toContain('SMTP_PORT is 1025')
      expect(error).toContain('MAIL_FROM is no-reply@example.com')
    })
  })

  describe('the transactional sender outside local', () => {
    const withoutTransactional = Object.fromEntries(
      Object.entries(deployed).filter(([key]) => key !== 'MAIL_FROM_TRANSACTIONAL')
    )

    it('warns, and still boots, when MAIL_FROM_TRANSACTIONAL is unset', () => {
      const { error, warnings } = runChecks(withoutTransactional)
      expect(error).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('MAIL_FROM_TRANSACTIONAL is unset')
      expect(warnings[0]).toContain('click')
      expect(warnings[0]).toContain('"Email tracking" in ARCHITECTURE.md')
    })

    it("warns when MAIL_FROM_TRANSACTIONAL is on MAIL_FROM's domain, in any case", () => {
      const { error, warnings } = runChecks({
        ...deployed,
        MAIL_FROM_TRANSACTIONAL: 'auth@Example.NET',
      })
      expect(error).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("shares MAIL_FROM's domain")
    })

    it('is silent when the transactional sender has a domain of its own', () => {
      expect(runChecks(deployed).warnings).toEqual([])
    })

    it('is silent on local, where both default to the placeholder', () => {
      expect(runChecks(local).warnings).toEqual([])
      expect(
        runChecks({ ...local, MAIL_FROM_TRANSACTIONAL: 'no-reply@example.com' }).error
      ).toBeUndefined()
    })
  })

  describe('SMTP credential pair', () => {
    it.each([
      { set: 'SMTP_USERNAME', missing: 'SMTP_PASSWORD' },
      { set: 'SMTP_PASSWORD', missing: 'SMTP_USERNAME' },
    ])('refuses $set without $missing, on local too', ({ set, missing }) => {
      const { error } = runChecks({ ...local, [set]: 'value' })
      expect(error).toContain(`Only ${set} is set. Set ${missing} too`)
    })

    it('accepts both, and neither', () => {
      expect(
        runChecks({ ...deployed, SMTP_USERNAME: 'apikey', SMTP_PASSWORD: 'secret' }).error
      ).toBeUndefined()
      expect(runChecks(deployed).error).toBeUndefined()
    })
  })

  describe('SMTP timeouts against SHUTDOWN_TIMEOUT_MS', () => {
    // The defaults fill SHUTDOWN_TIMEOUT_MS exactly: 15000 ms of SMTP, the 5000 ms HTTP drain and 5000 ms of headroom.
    const atBudget = {
      SMTP_CONNECTION_TIMEOUT_MS: '3000',
      SMTP_GREETING_TIMEOUT_MS: '5000',
      SMTP_SOCKET_TIMEOUT_MS: '7000',
      SHUTDOWN_TIMEOUT_MS: '25000',
    }

    it('accepts SMTP timeouts, drain and headroom summing exactly to SHUTDOWN_TIMEOUT_MS, as the defaults do', () => {
      expect(runChecks({ ...deployed, ...atBudget })).toEqual({ error: undefined, warnings: [] })
      expect(runChecks(deployed)).toEqual({ error: undefined, warnings: [] })
    })

    it('refuses SMTP timeouts 1 ms over budget outside local', () => {
      const { error } = runChecks({ ...deployed, ...atBudget, SMTP_SOCKET_TIMEOUT_MS: '7001' })
      expect(error).toContain(
        'SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS is 15001 ms'
      )
      expect(error).toContain(
        'more than the 15000 ms that SHUTDOWN_TIMEOUT_MS (25000 ms) leaves after the 5000 ms HTTP drain and 5000 ms of headroom'
      )
    })

    it('refuses a SHUTDOWN_TIMEOUT_MS cut 1 ms below the budget outside local', () => {
      const { error } = runChecks({ ...deployed, ...atBudget, SHUTDOWN_TIMEOUT_MS: '24999' })
      expect(error).toContain('is 15000 ms')
      expect(error).toContain('SHUTDOWN_TIMEOUT_MS (24999 ms) leaves')
    })

    it('only warns on local', () => {
      const { error, warnings } = runChecks({ ...local, SMTP_SOCKET_TIMEOUT_MS: '60000' })
      expect(error).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('SHUTDOWN_TIMEOUT_MS')
    })
  })

  describe('Secure cookies without TRUST_PROXY', () => {
    const google = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }

    it('warns, and still boots, when Google login is on', () => {
      const { error, warnings } = runChecks({ ...deployed, ...google, TRUST_PROXY: 'false' })
      expect(error).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('TRUST_PROXY is false')
    })

    it('warns on local when COOKIE_SECURE=true is explicit', () => {
      const { warnings } = runChecks({ ...local, ...google, COOKIE_SECURE: 'true' })
      expect(warnings).toHaveLength(1)
    })

    it.each([
      { name: 'TRUST_PROXY is set', source: { ...deployed, ...google, TRUST_PROXY: '1' } },
      {
        name: 'cookies are not Secure',
        source: { ...deployed, ...google, COOKIE_SECURE: 'false', TRUST_PROXY: 'false' },
      },
      { name: 'Google login is off', source: { ...deployed, TRUST_PROXY: 'false' } },
      { name: 'local derives Secure off', source: { ...local, ...google } },
    ])('stays quiet when $name', ({ source }) => {
      expect(runChecks(source).warnings).toEqual([])
    })
  })

  describe('PostHog without TRUST_PROXY', () => {
    const posthog = { POSTHOG_PROJECT_KEY: 'phc_test_key_not_real' }

    it('warns, and still boots, outside local', () => {
      const { error, warnings } = runChecks({ ...deployed, ...posthog, TRUST_PROXY: 'false' })
      expect(error).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('POSTHOG_PROJECT_KEY is set and TRUST_PROXY is false')
    })

    it.each([
      { name: 'TRUST_PROXY is set', source: { ...deployed, ...posthog, TRUST_PROXY: '1' } },
      { name: 'analytics is off', source: { ...deployed, TRUST_PROXY: 'false' } },
      { name: 'APP_ENV is local', source: { ...local, ...posthog, TRUST_PROXY: 'false' } },
      {
        name: 'NODE_ENV is test',
        source: { ...deployed, ...posthog, NODE_ENV: 'test', TRUST_PROXY: 'false' },
      },
    ])('stays quiet when $name', ({ source }) => {
      expect(
        runChecks(source).warnings.filter((warning) => warning.includes('POSTHOG_PROJECT_KEY'))
      ).toEqual([])
    })
  })

  describe('COOKIE_DOMAIN against APP_URL', () => {
    const api = { APP_URL: 'https://api.example.com' }

    it.each([
      { name: 'a parent domain', domain: 'example.com' },
      { name: 'a parent domain with a leading dot', domain: '.example.com' },
      { name: 'the exact host', domain: 'api.example.com' },
      { name: 'a parent domain in another case', domain: 'Example.COM' },
    ])('passes $name', ({ domain }) => {
      expect(runChecks({ ...deployed, ...api, COOKIE_DOMAIN: domain }).error).toBeUndefined()
    })

    it('passes when COOKIE_DOMAIN is unset', () => {
      expect(runChecks({ ...deployed, ...api }).error).toBeUndefined()
    })

    it.each([
      { name: 'another domain', domain: 'example.org' },
      { name: 'a domain that only shares a suffix', domain: 'le.com' },
      { name: 'a subdomain of the host', domain: 'eu.api.example.com' },
    ])('refuses $name on every APP_ENV', ({ domain }) => {
      for (const source of [
        { ...local, ...api, COOKIE_DOMAIN: domain },
        { ...deployed, ...api, COOKIE_DOMAIN: domain },
      ]) {
        expect(runChecks(source).error).toContain(
          `COOKIE_DOMAIN is ${domain}, but APP_URL's host api.example.com is not within it`
        )
      }
    })
  })

  it('lists every problem in one message', () => {
    const { error } = runChecks(
      { ...deployed, NODE_ENV: 'development', SMTP_HOST: 'localhost', SMTP_USERNAME: 'apikey' },
      { ...deployed, SMTP_PASS: 'old' }
    )
    expect(error).toMatch(/^Inconsistent environment:\n/)
    expect(error).toContain('SMTP_PASS was renamed to SMTP_PASSWORD')
    expect(error).toContain('NODE_ENV is development')
    expect(error).toContain('SMTP_HOST is localhost')
    expect(error).toContain('Only SMTP_USERNAME is set')
  })
})
