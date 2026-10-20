/**
 * @file Covers branches that google-oauth.test.ts and
 * google-oauth-disabled.test.ts (tests/integration/api/) cannot reach
 * through the HTTP layer. getEnv() is mocked as a `vi.fn()` rather than
 * a fixed-return factory, since configurePassport() calls it fresh on
 * every invocation, so a per-test `mockReturnValue` takes effect
 * without `vi.resetModules()`.
 */
import express from 'express'
import passport from 'passport'
import type { VerifyCallback } from 'passport-google-oauth20'
import { describe, expect, it, vi } from 'vitest'
import { getEnv, type Env } from '@/configs/env.config'
import {
  configurePassport,
  createOAuthSessionMiddleware,
  GOOGLE_STRATEGY_NAME,
} from '@/configs/passport.config'
import { resetRedisDeadlineForTests } from '@/services/redis-deadline.service'
import { getRedis } from '@/services/redis.service'
import { answerWithinBound, stalledCommand } from '../../helpers/redis-stall'
import { request } from '../../helpers/request'

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
  SIGN_IN_LINK_TTL: '15m',
  SIGN_IN_LINK_MAIL_COOLDOWN: '1m',
  SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT: 10,
  STEP_UP_LINK_TTL: '15m',
  STEP_UP_LINK_COOLDOWN: '1m',
  INVITATION_TTL: '3d',
  INVITATION_RESEND_COOLDOWN: '10m',
  INVITATION_RECIPIENT_DAILY_LIMIT: 10,
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
  FLAG_EVALUATE_REQUESTS_PER_MINUTE: 20,
  ERROR_TRACKING_ENABLED: false,
  APP_VERSION: 'dev',
  REDIS_KEY_PREFIX: 'express-boilerplate',
  SSE_HEARTBEAT_INTERVAL_MS: 30_000,
  SSE_MAX_STREAMS_PER_USER: 5,
  SSE_MAX_STREAMS_TOTAL: 2000,
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
 * The shape of `_verify`, the raw verify callback passport-oauth2 stores on a registered
 * strategy instance (`this._verify = verify` in passport-oauth2's lib/strategy.js). It is a
 * library-private field, so `@types/passport` does not type it.
 */
type StrategyVerify = (
  accessToken: string,
  refreshToken: string,
  profile: import('passport-google-oauth20').Profile,
  done: VerifyCallback
) => void

/**
 * Read the `_verify` function off the registered `'google'` strategy, and throw when none is
 * registered. It uses the same `as unknown as` cast as
 * tests/unit/utilities/email-template.utilities.test.ts, for a value with no safe static type.
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
 * configurePassport()'s own early-return and throw branches, which the two integration files
 * exercise only indirectly, through auth.routes.ts's `isGoogleOAuthEnabled()` guard. It also
 * covers passthroughGoogleProfile, the strategy's verify function, reached by pulling
 * `_verify` off the registered strategy instance instead of a real Google redirect.
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

  // The pass-through verify function: no database lookup, `done` called with the raw profile unchanged; account linking is the callback route's policy (`resolveGoogleUser`, google-auth.service.ts).
  it('passthroughGoogleProfile hands the raw profile straight to done, with no error', () => {
    vi.mocked(getEnv).mockReturnValue({
      ...baseEnv,
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
    })
    configurePassport()

    const verify = registeredVerifyCallback()
    // Arity 4: passport-oauth2 then calls it with the profile in third place, never the token endpoint's params.
    expect(verify).toHaveLength(4)
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
     * The cached promise must have been cleared, not left rejected: otherwise every later
     * request through this middleware would fail at once without calling getRedis() again.
     * The second attempt rejects too (succeeding would need a real RedisStore), and getRedis()
     * having been called a second time shows the first rejected promise was not reused.
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

  it('answers, within the deadline, when the session store does not answer', async () => {
    resetRedisDeadlineForTests()
    // A connected client whose session reads and writes never settle.
    const set = vi.fn(stalledCommand)
    const stalled = { get: stalledCommand, set, expire: stalledCommand, del: stalledCommand }
    vi.mocked(getRedis).mockResolvedValueOnce(stalled as never)
    const app = express()
    app.get('/auth/google', createOAuthSessionMiddleware(), (thisRequest, response) => {
      // Modified, so express-session saves it before the response ends, as the OAuth state does.
      Object.assign(thisRequest.session, { probe: 'state' })
      response.json({ ok: true })
    })

    const response = await answerWithinBound((async () => request(app).get('/auth/google'))())

    expect(response).not.toBe('hung')
    // The session save reached the stalled store: the deadline, not a skipped save, ended the wait.
    expect(set).toHaveBeenCalledTimes(1)
    resetRedisDeadlineForTests()
  })
})
