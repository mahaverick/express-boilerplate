// tests/unit/controllers/auth.controller.test.ts
//
// Covers only `isSecureCookieEnvironment` — the one piece of
// auth.controller.ts with no database dependency at all, which is what
// makes it safe to run without Docker (see CLAUDE.md on why a
// database-dependent test must never live under tests/unit/). Registration
// and login themselves are exercised end to end against the real database
// in tests/integration/api/auth.test.ts.
//
// getEnv() is mocked as a vi.fn() (not a fixed-return factory) specifically
// so a SINGLE vi.mock call — hoisted once per file — can still answer
// differently across tests: one proving the `production` branch, one
// proving every other environment. auth.controller.ts calls getEnv() fresh
// on every invocation rather than caching it locally, which is what makes a
// per-test mockReturnValue actually take effect. A fixed, hand-built `Env`
// object (rather than reading the real getEnv() at test time) keeps each
// assertion independent of whatever the previous test last configured the
// mock to return.
import { describe, expect, it, vi } from 'vitest'
import { getEnv, type Env } from '@/configs/env.config'
import { isSecureCookieEnvironment } from '@/controllers/auth.controller'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

const baseEnv: Env = {
  NODE_ENV: 'test',
  APP_PORT: 4040,
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  SESSION_ABSOLUTE_TTL: '30d',
  TRUST_PROXY: 'false',
  LOG_LEVEL: 'info',
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  MAIL_FROM: 'no-reply@example.com',
}

describe('isSecureCookieEnvironment', () => {
  it('is true in production, so the refresh cookie is never sent over plain HTTP', () => {
    vi.mocked(getEnv).mockReturnValue({ ...baseEnv, NODE_ENV: 'production' })
    expect(isSecureCookieEnvironment()).toBe(true)
  })

  it('is false outside production, so login still works over local HTTP', () => {
    vi.mocked(getEnv).mockReturnValue({ ...baseEnv, NODE_ENV: 'development' })
    expect(isSecureCookieEnvironment()).toBe(false)

    vi.mocked(getEnv).mockReturnValue({ ...baseEnv, NODE_ENV: 'test' })
    expect(isSecureCookieEnvironment()).toBe(false)
  })
})
