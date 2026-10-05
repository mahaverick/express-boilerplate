/**
 * @file Covers branches
 * google-oauth.test.ts/google-oauth-disabled.test.ts cannot reach
 * through the HTTP layer. getEnv() is mocked as a `vi.fn()` rather than
 * a fixed-return factory, since configurePassport() calls it fresh on
 * every invocation, so a per-test `mockReturnValue` takes effect
 * without `vi.resetModules()`.
 */
import passport from 'passport'
import type { VerifyCallback } from 'passport-google-oauth20'
import { describe, expect, it, vi } from 'vitest'
import { getEnv, type Env } from '@/configs/env.config'
import {
  configurePassport,
  createOAuthSessionMiddleware,
  GOOGLE_STRATEGY_NAME,
} from '@/configs/passport.config'
import { getRedis } from '@/services/redis.service'

vi.mock('@/configs/env.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/env.config')>()
  return { ...actual, getEnv: vi.fn(actual.getEnv) }
})

vi.mock('@/services/redis.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/redis.service')>()
  return { ...actual, getRedis: vi.fn(actual.getRedis) }
})

const baseEnv: Env = {
  APP_ENV: 'local',
  NODE_ENV: 'test',
  APP_PORT: 4040,
  APP_URL: 'http://localhost:4040',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/boilerplate',
  REDIS_URL: 'redis://localhost:6379',
  DB_POOL_MAX: 10,
  DB_STATEMENT_TIMEOUT_MS: 30_000,
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  SESSION_SECRET: 'c'.repeat(32),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  SESSION_ABSOLUTE_TTL: '30d',
  EMAIL_VERIFICATION_TTL: '24h',
  PASSWORD_RESET_TTL: '1h',
  ACCOUNT_SETUP_TTL: '24h',
  INVITATION_TTL: '7d',
  TRUST_PROXY: 'false',
  OTEL_SERVICE_NAME: 'express-boilerplate',
  LOG_LEVEL: 'silent',
  SLACK_LOG_LEVEL: 'error',
  WORKER_ENABLED: true,
  WORKER_CONCURRENCY: 5,
  RETENTION_TOKENS_DAYS: 7,
  RETENTION_INVITATIONS_DAYS: 30,
  RETENTION_EMAIL_LOGS_DAYS: 90,
  RETENTION_NOTIFICATIONS_READ_DAYS: 90,
  RETENTION_NOTIFICATIONS_UNREAD_DAYS: 365,
  RETENTION_AUDIT_LOGS_DAYS: 0,
  ONBOARDING_STUCK_AFTER_DAYS: 7,
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ANALYTICS_OUTBOX_RETENTION_DAYS: 7,
  ANALYTICS_DRAIN_INTERVAL_MS: 5000,
  ANALYTICS_DRAIN_BATCH_SIZE: 500,
  TIMELINE_QUERY_BUDGET_PER_HOUR: 1200,
  TIMELINE_REQUESTS_PER_MINUTE: 20,
  ERROR_TRACKING_ENABLED: false,
  APP_VERSION: 'dev',
  REDIS_KEY_PREFIX: 'express-boilerplate',
  SSE_HEARTBEAT_INTERVAL_MS: 30_000,
  SSE_MAX_STREAMS_PER_USER: 5,
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  MAIL_FROM: 'no-reply@example.com',
  APP_NAME: 'Test App',
  FAKE_EMAIL_WEBHOOK_SECRET: 'fake-webhook',
  SMTP_CONNECTION_TIMEOUT_MS: 5000,
  SMTP_GREETING_TIMEOUT_MS: 5000,
  SMTP_SOCKET_TIMEOUT_MS: 10_000,
  SHUTDOWN_TIMEOUT_MS: 25_000,
}

/**
 * The shape of `_verify`, the raw verify callback passport-oauth2 stashes on
 * a registered strategy instance — `this._verify = verify`, unwrapped, per
 * passport-oauth2/lib/strategy.js. Untyped by `@types/passport`, since it is
 * a library-private field, not part of the public API.
 */
type StrategyVerify = (
  accessToken: string,
  refreshToken: string,
  profile: import('passport-google-oauth20').Profile,
  done: VerifyCallback
) => void

/**
 * Read the `_verify` function off the registered `'google'` strategy. Same
 * `as unknown as` cast this codebase already uses elsewhere for a value with
 * no safe static type (see e.g.
 * tests/unit/utilities/email-template.utilities.test.ts).
 * @returns The verify callback `configurePassport()` registered.
 */
function registeredVerifyCallback(): StrategyVerify {
  const strategies = (
    passport as unknown as { _strategies: Record<string, { _verify: StrategyVerify } | undefined> }
  )._strategies
  const strategy = strategies[GOOGLE_STRATEGY_NAME]
  if (!strategy) {
    throw new Error(
      `No '${GOOGLE_STRATEGY_NAME}' strategy registered — call configurePassport() first`
    )
  }
  return strategy._verify
}

/**
 * configurePassport()'s own early-return and throw branches: both
 * integration files only ever exercise it indirectly, through
 * auth.routes.ts's `isGoogleOAuthEnabled()` guard. Below also covers
 * passthroughGoogleProfile, the strategy's verify function, reached
 * here by pulling `_verify` off the registered strategy instance
 * rather than a real Google redirect.
 */
describe('configurePassport', () => {
  it('is a no-op when GOOGLE_CLIENT_ID is absent', () => {
    vi.mocked(getEnv).mockReturnValue({
      ...baseEnv,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    })

    expect(() => configurePassport()).not.toThrow()
    expect(
      (passport as unknown as { _strategies: Record<string, unknown> })._strategies[
        GOOGLE_STRATEGY_NAME
      ]
    ).toBeUndefined()
  })

  it('throws when GOOGLE_CLIENT_ID is set without GOOGLE_CLIENT_SECRET', () => {
    vi.mocked(getEnv).mockReturnValue({
      ...baseEnv,
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: undefined,
    })

    expect(() => configurePassport()).toThrow(
      'GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set'
    )
  })

  it('registers the google strategy when both credentials are set', () => {
    vi.mocked(getEnv).mockReturnValue({
      ...baseEnv,
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    })

    configurePassport()

    expect(
      (passport as unknown as { _strategies: Record<string, unknown> })._strategies[
        GOOGLE_STRATEGY_NAME
      ]
    ).toBeDefined()
  })

  // The pass-through verify function: no database lookup, `done` called with the raw profile unchanged — that policy decision belongs to a later route, not here.
  it('passthroughGoogleProfile hands the raw profile straight to done, with no error', () => {
    vi.mocked(getEnv).mockReturnValue({
      ...baseEnv,
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    })
    configurePassport()

    const verify = registeredVerifyCallback()
    const done = vi.fn()
    const profile = { id: 'google-user-id', displayName: 'Ada Lovelace' } as unknown as Parameters<
      typeof verify
    >[2]

    verify('access-token', 'refresh-token', profile, done)

    // eslint-disable-next-line unicorn/no-null -- asserting against Passport's own Node-style callback convention (see passport.config.ts's own disable comment on the line this proves).
    expect(done).toHaveBeenCalledWith(null, profile)
  })
})

describe('createOAuthSessionMiddleware', () => {
  it('calls next with the error and clears the cached attempt when Redis is unreachable, so a later request can retry', async () => {
    vi.mocked(getRedis).mockRejectedValueOnce(new Error('redis unreachable'))

    const middleware = createOAuthSessionMiddleware()
    const next = vi.fn()

    await middleware(
      {} as Parameters<typeof middleware>[0],
      {} as Parameters<typeof middleware>[1],
      next
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(expect.any(Error))

    /**
     * The cached promise must have been cleared, not left rejected forever
     * — otherwise every later request through this same middleware
     * instance would fail immediately without calling getRedis() again.
     * Proven by making the second attempt reject too (succeeding would
     * need a real RedisStore) and confirming getRedis() was called a
     * second time rather than reusing the first rejected promise.
     */
    vi.mocked(getRedis).mockRejectedValueOnce(new Error('still unreachable'))
    const secondNext = vi.fn()
    await middleware(
      {} as Parameters<typeof middleware>[0],
      {} as Parameters<typeof middleware>[1],
      secondNext
    )

    expect(secondNext).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getRedis)).toHaveBeenCalledTimes(2)
  })
})
