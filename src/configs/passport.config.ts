// src/configs/passport.config.ts
//
// Three exports, each earning its own reason to exist:
//
// `isGoogleOAuthEnabled()` gates whether `auth.routes.ts` mounts the OAuth
// routes at all — a deployment with no Google credentials configured never
// exposes `/auth/google`, rather than exposing it and failing on first use.
//
// `configurePassport()` registers the `'google'` strategy with a
// deliberately TRIVIAL verify function — `passthroughGoogleProfile` below
// just hands the raw Google `Profile` to `done()` unchanged, with no
// database lookup of its own. The brief this file was built from sketched
// `configurePassport(handleGoogleVerify: Function)`, threading a verify
// callback in from the caller, but that shape has no caller that can supply
// one: `auth.routes.ts` (this task) only wires the redirect step, which
// never runs a verify function at all — Google hasn't redirected back yet.
// The callback step (a later task) needs the RAW profile, not a resolved
// user, because deciding whether to link an existing account, reject an
// unverified email, or create a new one is exactly the account-linking
// policy that route owns — `passport.authenticate('google', { session:
// false }, (error, profile, info) => { ... })`'s own custom-callback
// signature receives whatever `done()` was called with here, which is why
// a pass-through, not a database-backed verify function, is what belongs in
// this shared config file. Registering the strategy still has to happen
// exactly once, before either route handles a request, so `createAuthRouter`
// (auth.routes.ts) calls this before mounting `/google`.
//
// `createOAuthSessionMiddleware()` builds the express-session middleware
// backed by connect-redis's `RedisStore`. It does NOT call `new
// RedisStore({ client: getRedis() })` directly — `getRedis()` (from
// `@/services/redis.service`) returns a `Promise<RedisClientType>`, and
// connect-redis v10's `RedisStore` assigns whatever it is given to
// `this.client` with no unwrapping (verified by reading
// `node_modules/connect-redis/index.ts`: `constructor(opts) { this.client =
// opts.client }`, then every method calls `this.client.get(...)` etc.
// directly). Handing it a Promise would not "queue commands until connect"
// the way a live node-redis client does — it would make every session
// operation crash with `this.client.get is not a function` on the very
// first request, since a `Promise` has no `get` method. This is exactly the
// failure mode the brief's own "verify empirically" note warned about, and
// it does not work: confirmed by reading connect-redis's source rather than
// only by running the route (see this file's own test coverage in
// `tests/integration/api/google-oauth.test.ts`, which exercises the real
// lazy-connect path). The fix mirrors `SharedRateLimitStore`'s own
// established pattern in this codebase (`rate-limit-store.config.ts`):
// resolve the async dependency once, lazily, on first use, and reuse the
// resolved value afterwards — except here the thing being latched is the
// `express-session` middleware itself, not a `Store`, since `RedisStore`
// has no equivalent to `SharedRateLimitStore`'s per-command
// `sendCommand: async (...) => (await getRedis()).sendCommand(...)` — its
// `client` field is set once, at construction, and read synchronously
// thereafter.
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
import { getRedis } from '@/services/redis.service'

// Defined in constants/auth.constants.ts (see its JSDoc); re-exported for
// auth.routes.ts.
export { GOOGLE_STRATEGY_NAME } from '@/constants/auth.constants'

/**
 * Whether Google login is configured for this deployment.
 *
 * `auth.routes.ts` uses this to decide whether `/auth/google` (and, in a
 * later task, `/auth/google/callback`) are mounted at all — an unconfigured
 * deployment never exposes either route, rather than exposing one that
 * would fail on first use.
 * @returns True when `GOOGLE_CLIENT_ID` is set.
 */
export function isGoogleOAuthEnabled(): boolean {
  return getEnv().GOOGLE_CLIENT_ID !== undefined
}

/**
 * The Google strategy's verify function: a deliberate pass-through.
 *
 * See this file's header comment for why NO database lookup belongs here —
 * the account-linking policy (find-by-provider, link-by-verified-email,
 * create) is a later task's concern, decided from the raw profile this
 * hands to `passport.authenticate`'s own custom callback, not from
 * whatever a verify function here might have already resolved.
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
  // The cast is deliberate, not a type-safety hole: `Express.User` is THIS
  // codebase's JWT-authenticated principal (src/types/express.d.ts extends
  // it with `AuthenticatedUser` specifically so `request.user` keeps its
  // real shape) — Passport's own `VerifyCallback` type reuses that same
  // name generically for "whatever a verify function resolves to", which
  // for this pass-through strategy is a raw Google profile, not an
  // `AuthenticatedUser`. Nothing downstream ever assigns this value to
  // `request.user`: the OAuth callback route (a later task) calls
  // `passport.authenticate('google', { session: false }, ...)`, so Passport
  // never calls `req.login()` with it — the profile only ever reaches that
  // route's own custom callback, whose parameters it types independently.
  // eslint-disable-next-line unicorn/no-null -- Passport's own Node-style callback convention uses `null` as the "no error" sentinel; `VerifyCallback` is a third-party signature this file must match exactly
  done(null, profile as unknown as Express.User)
}

/**
 * Register the Google OAuth strategy when credentials are configured.
 *
 * A no-op when `GOOGLE_CLIENT_ID` is absent — matches
 * `isGoogleOAuthEnabled()`'s own check, so a caller that guards route
 * mounting on that function never needs a second guard here. Throws,
 * rather than silently disabling Google login, when `GOOGLE_CLIENT_ID` is
 * set without `GOOGLE_CLIENT_SECRET`: the two are both `.optional()` in
 * `EnvSchema` (a schema-level `.refine()` expressing "required together"
 * would break `EnvSchema.pick()` — see `getDatabaseUrl()`'s own comment in
 * env.config.ts), so this is the one place left to enforce the pairing.
 * Same "refuse to start" posture as `trustProxySetting`'s own header
 * comment describes for a different misconfigured security setting: a
 * half-configured OAuth provider is closer to a typo than a valid
 * deployment choice, and a process that fails at boot names the mistake
 * where a silently-disabled route would only leave a caller wondering why
 * `/auth/google` 404s.
 *
 * Idempotent to call more than once — `passport.use` simply overwrites the
 * previous registration under the same name — so `auth.routes.ts` calling
 * this every time `createAuthRouter()` runs (once per `createApp()`, not
 * per request) never accumulates duplicate strategies.
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
        // Reads/writes `req.session.state` across the redirect round-trip —
        // the CSRF protection this OAuth flow relies on. Requires
        // `req.session` to already exist, which is why the session
        // middleware `createOAuthSessionMiddleware()` builds must be
        // mounted ahead of `passport.authenticate('google', ...)` on both
        // routes, not just the callback.
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
 * Build the `express-session` options shared by every request once a Redis
 * client is available. Split out from `createOAuthSessionMiddleware` only
 * so the lazy-latch wrapper below has a single, obviously-pure place to get
 * these from — not a caching concern of its own.
 * @param client - A connected (or connecting-but-queuing) node-redis client.
 * @returns Options for `express-session`'s `session()` factory.
 */
function buildOAuthSessionOptions(client: Awaited<ReturnType<typeof getRedis>>): SessionOptions {
  const env = getEnv()
  return {
    store: new RedisStore({ client }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: OAUTH_SESSION_COOKIE_NAME,
    cookie: {
      maxAge: OAUTH_SESSION_MAX_AGE_MS,
      httpOnly: true,
      // express-session drops a Secure cookie unless req.secure, so behind TLS
      // termination this needs TRUST_PROXY and X-Forwarded-Proto.
      secure: isCookieSecure(env),
      sameSite: 'lax',
      ...(env.COOKIE_DOMAIN !== undefined && { domain: env.COOKIE_DOMAIN }),
    },
  }
}

/**
 * Build the express-session middleware for the OAuth round-trip,
 * scoped to `/auth/google` and `/auth/google/callback` ONLY — the rest of
 * this API is stateless JWT, so this must never be mounted globally in
 * `app.ts`.
 *
 * Returns a MIDDLEWARE, not a `Promise<middleware>`, even though building
 * the real thing needs a connected Redis client and `getRedis()` is async —
 * `router.get('/google', createOAuthSessionMiddleware(), ...)` is called
 * synchronously while `createAuthRouter()` assembles the router, long
 * before an event loop tick exists to await anything on. The function
 * below instead returns a synchronous middleware that lazily builds the
 * REAL `express-session` middleware exactly once — on whichever request
 * arrives first — caches that promise, and delegates every request
 * (including that first one) to it once it resolves. This is the identical
 * shape `SharedRateLimitStore.latchOntoRedisIfReady()`
 * (rate-limit-store.config.ts) uses for the same underlying reason: an
 * async dependency behind a synchronous construction point. It differs
 * from that store in one way worth naming — this latch never falls back to
 * an in-memory alternative on failure, because there isn't a safe one:
 * `SharedRateLimitStore` degrades to per-process counting when Redis is
 * unreachable and accepts a wider limit as the cost, but an in-memory
 * session store would silently break the OAuth CSRF `state` check the
 * moment a second process (or a restart mid-flow) is involved. A failed
 * attempt is cached only long enough to fail every in-flight request with
 * it, then cleared so the NEXT request retries — the same "allow a later
 * call to retry" rule `SharedRateLimitStore.tryLatch()` follows for its own
 * failure path.
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
      // The attempt that just failed must never poison a later request —
      // `getRedis()` itself supports retrying (redis.service.ts creates a
      // fresh client on the next call whenever the previous connect attempt
      // never succeeded), so this latch should too.
      middlewarePromise = undefined
      next(error)
    }
  }
}
