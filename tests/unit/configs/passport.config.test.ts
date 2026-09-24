// tests/unit/configs/passport.config.test.ts
//
// Covers the branches google-oauth.test.ts/google-oauth-disabled.test.ts
// cannot reach through the HTTP layer:
//
//   - `configurePassport()`'s own early-return and throw branches. Both
//     integration files only ever exercise `configurePassport()` INDIRECTLY,
//     through `auth.routes.ts`'s `if (isGoogleOAuthEnabled()) configurePassport()`
//     guard (auth.routes.ts:131) — so the "GOOGLE_CLIENT_ID unset" case never
//     calls `configurePassport()` at all, and the "id set, secret unset"
//     case has no way to arise through that guard (the guard only checks the
//     id). Both are called directly here instead.
//   - `passthroughGoogleProfile`, the strategy's verify function. Nothing in
//     this suite completes a real Google OAuth round-trip (google-oauth.test.ts's
//     own header comment: "nothing in this test ever calls Google"), so
//     Passport never invokes it. `configurePassport()` registers it as
//     `_verify` on the strategy instance passport-oauth2 constructs
//     (verified by reading passport-oauth2/lib/strategy.js: `this._verify =
//     verify` — unwrapped, not re-bound), so retrieving the registered
//     strategy off the shared `passport` singleton and invoking `_verify`
//     directly is the one way to reach it without a real Google redirect.
//   - `createOAuthSessionMiddleware()`'s catch branch: `getRedis()` rejecting
//     must call `next(error)` and clear the cached promise so a later
//     request can retry, per this file's own header comment on why a failed
//     attempt must never poison one after it.
//
// getEnv() is mocked as a vi.fn() (not a fixed-return factory), same
// technique and reasoning as auth.controller.test.ts: configurePassport()
// calls getEnv() fresh on every invocation, so a per-test mockReturnValue
// takes effect without needing vi.resetModules() (and the live postgres
// pool leak that carries — tests/helpers/mutate.ts's own header comment).
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
  EMAIL_VERIFICATION_TTL: '24h',
  PASSWORD_RESET_TTL: '1h',
  INVITATION_TTL: '7d',
  TRUST_PROXY: 'false',
  OTEL_SERVICE_NAME: 'express-boilerplate',
  LOG_LEVEL: 'silent',
  SLACK_LOG_LEVEL: 'error',
  WORKER_ENABLED: true,
  QUEUE_PREFIX: 'bull',
  SSE_HEARTBEAT_INTERVAL_MS: 30_000,
  SSE_MAX_STREAMS_PER_USER: 5,
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  MAIL_FROM: 'no-reply@example.com',
  APP_NAME: 'Test App',
  SMTP_CONNECTION_TIMEOUT: 5000,
  SMTP_GREETING_TIMEOUT: 5000,
  SMTP_SOCKET_TIMEOUT: 10_000,
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

  // The pass-through verify function: no database lookup, `done` called
  // with the raw profile unchanged — this file's own header comment
  // explains why that policy decision belongs to a later route, not here.
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

    // The cached promise must have been cleared, not left rejected forever
    // — otherwise every later request through this same middleware instance
    // would fail immediately without ever calling getRedis() again. Proven
    // by making the second attempt reject too (rather than succeed, which
    // would need a real RedisStore) and confirming getRedis() was called a
    // SECOND time rather than reusing the first rejected promise.
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
