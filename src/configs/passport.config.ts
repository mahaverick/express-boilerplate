/**
 * @file Google OAuth wiring: whether it is enabled, the pass-through Google
 * strategy, and the Redis-backed express-session middleware that carries the
 * OAuth `state` across the redirect round-trip.
 */
import { RedisStore } from 'connect-redis'
import type { RequestHandler } from 'express'
import session, { type SessionOptions } from 'express-session'
import passport from 'passport'
import {
  Strategy as GoogleStrategy,
  type Profile as GoogleProfile,
  type VerifyCallback,
} from 'passport-google-oauth20'
import { getEnv, isCookieSecure } from '@/configs/env.config'
import { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'

export { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'

/**
 * Whether Google login is configured for this deployment.
 *
 * `auth.routes.ts` mounts `/auth/google` and `/auth/google/callback` only when
 * this is true, so an unconfigured deployment never exposes a route that
 * would fail on first use.
 * @returns True when `GOOGLE_CLIENT_ID` is set.
 */
export function isGoogleOAuthEnabled(): boolean {
  return getEnv().GOOGLE_CLIENT_ID !== undefined
}

/**
 * The Google strategy's verify function: a deliberate pass-through.
 *
 * No database lookup: the callback route's account-linking policy
 * (`findOrCreateByGoogle`, google-auth.service.ts) needs the raw profile,
 * which reaches that route's custom `passport.authenticate` callback. The
 * profile never becomes `request.user`: the callback authenticates with
 * `session: false`, so Passport never calls `req.login()` with it.
 * @param _accessToken - Google's OAuth access token. Unused: nothing here calls the Google API again.
 * @param _refreshToken - Google's OAuth refresh token. Unused, for the same reason.
 * @param profile - The authenticated user's Google profile.
 * @param done - Passport's completion callback; called with the profile itself as the "user".
 */
function passthroughGoogleProfile(
  _accessToken: string,
  _refreshToken: string,
  profile: GoogleProfile,
  done: VerifyCallback
): void {
  // Cast: Passport's `VerifyCallback` names `Express.User`, which this codebase types as the JWT user.
  // eslint-disable-next-line unicorn/no-null -- Passport's own Node-style callback convention uses `null` as the "no error" sentinel; `VerifyCallback` is a third-party signature this file must match exactly
  done(null, profile as unknown as Express.User)
}

/**
 * Register the Google OAuth strategy when credentials are configured.
 *
 * A no-op when `GOOGLE_CLIENT_ID` is absent, the same check as
 * `isGoogleOAuthEnabled()`. Both variables are optional in `EnvSchema`, so
 * this is where the pair is enforced: a client id without a secret refuses
 * boot rather than silently disabling Google login. Safe to call once per
 * `createApp()`: `passport.use` replaces the registration under the same name.
 * @throws {Error} When `GOOGLE_CLIENT_ID` is set without `GOOGLE_CLIENT_SECRET`.
 */
export function configurePassport(): void {
  const env = getEnv()
  if (env.GOOGLE_CLIENT_ID === undefined) return

  if (env.GOOGLE_CLIENT_SECRET === undefined) {
    throw new Error('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set')
  }

  passport.use(
    GOOGLE_STRATEGY_NAME,
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${env.APP_URL}/api/v1/auth/google/callback`,
        scope: ['profile', 'email'],
        // CSRF protection: needs the OAuth session mounted before passport on both routes.
        state: true,
      },
      passthroughGoogleProfile
    )
  )

  logger.info('Google OAuth strategy registered')
}

const OAUTH_SESSION_COOKIE_NAME = 'oauth.sid'
const OAUTH_SESSION_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Build the `express-session` options once a Redis client is available.
 * @param client - A connected (or connecting-but-queuing) node-redis client.
 * @returns Options for `express-session`'s `session()` factory.
 */
function buildOAuthSessionOptions(client: Awaited<ReturnType<typeof getRedis>>): SessionOptions {
  const env = getEnv()
  return {
    // connect-redis's own default prefix, `sess:`, would sit outside REDIS_KEY_PREFIX.
    store: new RedisStore({ client, prefix: `${redisKey('sess')}:` }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: OAUTH_SESSION_COOKIE_NAME,
    cookie: {
      maxAge: OAUTH_SESSION_MAX_AGE_MS,
      httpOnly: true,
      // express-session drops a Secure cookie unless req.secure: behind TLS set TRUST_PROXY.
      secure: isCookieSecure(env),
      sameSite: 'lax',
      ...(env.COOKIE_DOMAIN !== undefined && { domain: env.COOKIE_DOMAIN }),
    },
  }
}

/**
 * Build the express-session middleware for the OAuth round-trip, for
 * `/auth/google` and `/auth/google/callback` only: the rest of the API is
 * stateless JWT, so never mount it globally.
 *
 * The router is assembled synchronously, but connect-redis's `RedisStore`
 * needs a connected client (it stores whatever `client` it is given, so a
 * `Promise` would fail every session call). The returned middleware builds
 * the real one on the first request and reuses it. There is no in-memory
 * fallback: a per-process session store would break the OAuth `state` check
 * across processes or a restart mid-flow. A failed build fails the requests
 * awaiting it and is cleared, so the next request retries.
 * @returns Express middleware that becomes the real session handler once Redis is reachable.
 */
export function createOAuthSessionMiddleware(): RequestHandler {
  let middlewarePromise: Promise<RequestHandler> | undefined

  async function buildMiddleware(): Promise<RequestHandler> {
    const client = await getRedis()
    return session(buildOAuthSessionOptions(client))
  }

  return async (request, response, next) => {
    try {
      middlewarePromise ??= buildMiddleware()
      const middleware = await middlewarePromise
      middleware(request, response, next)
    } catch (error) {
      middlewarePromise = undefined
      next(error)
    }
  }
}
