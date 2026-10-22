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
import { withRedisDeadline } from '@/services/redis-deadline.service'
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
 * The Google strategy's verify function: a deliberate pass-through that hands
 * the raw Google profile to Passport as the "user" and ignores both tokens.
 *
 * No database lookup: the callback route's account-linking policy
 * (`resolveGoogleUser`, google-auth.service.ts) needs the raw profile,
 * which reaches that route's custom `passport.authenticate` callback. The
 * profile never becomes `request.user`: the callback authenticates with
 * `session: false`, so Passport never calls `req.login()` with it.
 */
function passthroughGoogleProfile(
  _accessToken: string,
  _refreshToken: string,
  profile: GoogleProfile,
  done: VerifyCallback
): void {
  // Cast: Passport's `VerifyCallback` names `Express.User`, which this codebase types as the JWT user.
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
        // Checks the callback's state against the one kept in the OAuth session (login CSRF defence), so that session must be mounted before passport on both routes.
        state: true,
      },
      passthroughGoogleProfile
    )
  )

  logger.info('Google OAuth strategy registered')
}

const OAUTH_SESSION_COOKIE_NAME = 'oauth.sid'
/**
 * How long one OAuth round-trip's session lives: the Google start must reach
 * the callback within it.
 */
const OAUTH_SESSION_MAX_AGE_MS = 5 * 60 * 1000

/**
 * The OAuth session cookie's name, with the strongest prefix the deployment
 * allows, as `refreshCookieSpec` (auth.constants.ts) picks for the refresh
 * cookie: an unprefixed one can be planted by a sibling subdomain or by an
 * attacker on plain http, binding a victim's callback to the planter's
 * `state`. `__Host-` stops both and needs Secure, no Domain and Path=/
 * (express-session's default path). `__Secure-` allows the COOKIE_DOMAIN but
 * stops only the plain-http planter, since COOKIE_DOMAIN already trusts its
 * subdomains.
 * @param env - Whether cookies are Secure and the configured COOKIE_DOMAIN.
 * @param env.COOKIE_SECURE - Whether cookies are Secure, resolved through `isCookieSecure`.
 * @param env.COOKIE_DOMAIN - The configured COOKIE_DOMAIN, if any.
 * @returns The cookie name express-session sets and reads.
 */
function oauthSessionCookieName(env: {
  COOKIE_SECURE: boolean
  COOKIE_DOMAIN?: string | undefined
}): string {
  if (!env.COOKIE_SECURE) return OAUTH_SESSION_COOKIE_NAME
  return env.COOKIE_DOMAIN === undefined
    ? `__Host-${OAUTH_SESSION_COOKIE_NAME}`
    : `__Secure-${OAUTH_SESSION_COOKIE_NAME}`
}

/**
 * The type of the shared Redis client that `getRedis()` resolves.
 */
type RedisClient = Awaited<ReturnType<typeof getRedis>>

/**
 * The client connect-redis is given: the commands it sends while a request
 * waits (`get`, `set`, `expire` for a touch, `del` for a destroy) run under
 * `withRedisDeadline`, so a stalled Redis fails the OAuth request through
 * express-session's error path instead of holding it. Every other property
 * is the client's own, bound to it.
 * @param client - The shared client.
 * @returns A view of the client with those four commands bounded.
 */
function boundedSessionClient(client: RedisClient): RedisClient {
  const bounded = new Map<PropertyKey, unknown>([
    ['get', (key: string) => withRedisDeadline(() => client.get(key), 'OAuth session read')],
    [
      'set',
      (key: string, value: string, options?: Parameters<RedisClient['set']>[2]) =>
        withRedisDeadline(() => client.set(key, value, options), 'OAuth session write'),
    ],
    [
      'expire',
      (key: string, seconds: number) =>
        withRedisDeadline(() => client.expire(key, seconds), 'OAuth session touch'),
    ],
    [
      'del',
      (keys: string | string[]) =>
        withRedisDeadline(() => client.del(keys), 'OAuth session destroy'),
    ],
  ])
  return new Proxy(client, {
    get(target, property): unknown {
      if (bounded.has(property)) return bounded.get(property)
      // Bound to the real client: its methods may use private fields a Proxy receiver lacks.
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...parameters: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

/**
 * The `express-session` options for the OAuth round-trip: a session lasts 5
 * minutes in Redis under the app's key prefix, and one no route wrote to is
 * never saved.
 * @param client - The shared Redis client.
 * @returns Options for `express-session`'s `session()` factory.
 */
function buildOAuthSessionOptions(client: RedisClient): SessionOptions {
  const env = getEnv()
  return {
    // connect-redis's own default prefix, `sess:`, would sit outside REDIS_KEY_PREFIX.
    store: new RedisStore({ client: boundedSessionClient(client), prefix: `${redisKey('sess')}:` }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: oauthSessionCookieName({
      COOKIE_SECURE: isCookieSecure(env),
      COOKIE_DOMAIN: env.COOKIE_DOMAIN,
    }),
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
 * Wait for the shared Redis client and build the real session middleware on
 * it. Rejects when Redis misses the `withRedisDeadline` deadline.
 */
async function buildOAuthSessionMiddleware(): Promise<RequestHandler> {
  const client = await withRedisDeadline(() => getRedis(), 'OAuth session store')
  return session(buildOAuthSessionOptions(client))
}

/**
 * Build the express-session middleware for the OAuth round-trip, for the
 * Google routes only (`/auth/google` and its callback): the rest of the API is stateless JWT, so never mount it globally.
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

  return async (request, response, next) => {
    try {
      middlewarePromise ??= buildOAuthSessionMiddleware()
      const middleware = await middlewarePromise
      middleware(request, response, next)
    } catch (error) {
      middlewarePromise = undefined
      next(error)
    }
  }
}
