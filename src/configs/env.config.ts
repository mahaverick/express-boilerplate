// src/configs/env.config.ts
//
// WHY THIS EXISTS. Every module reads configuration from this object, never
// from process.env — the eslint rule no-restricted-properties enforces it.
//
// Reading process.env at the point of use means a missing variable surfaces
// as `undefined` far from its cause. This repo's own history is the argument:
// before this rewrite, `ms(process.env.REFRESH_TOKEN_EXPIRY)` threw
// "val is not a non-empty string or a valid number" at module-import time,
// which stopped auth.controller.test.ts from running at all — so the backend
// had exactly one passing test and the reason looked like a bug in `ms`.
//
// Parsing once, at boot, turns that into one readable list of what is wrong.
import { config } from 'dotenv'
import { z } from 'zod'
import { parseDurationMs } from '@/utilities/duration.utilities'
import { EMAIL_DOMAIN_PATTERN } from '@/utilities/email.utilities'

// Populate process.env from .env before anything below ever reads it.
// `pnpm dev` and `pnpm start` already load it with Node's --env-file-if-exists
// (tracing.ts needs it first), and dotenv never overrides a set key, so there
// it only fills keys Node's parser left unset; tsx scripts rely on it.
// Skipped under Vitest: tests/helpers/setup-global.ts already assembles the
// test environment (process env > .env.test.local > .env.test) before any
// test file is imported, and loading a developer's own .env on top of that
// would leak their local, personal config into the suite — a test that
// passes on one machine and fails on another for reasons that look nothing
// like configuration. `quiet` suppresses dotenv's own startup banner, which
// would otherwise land on stdout ahead of anything this process prints,
// corrupting any command whose output is meant to be machine-readable.
if (!process.env.VITEST) {
  config({ quiet: true })
}

// z.httpUrl() is deliberately NOT used here, despite being the obvious
// top-level function for "an http(s) URL". Its params type omits "hostname"
// (Omit<$ZodURLParams, "protocol" | "hostname">) because it hardcodes a
// public-hostname pattern requiring a dotted TLD — verified empirically:
// z.httpUrl().safeParse('http://localhost:4040') fails with "Invalid
// hostname". That rejects every local dev URL and every Docker service name
// (e.g. an OTEL collector at http://otel-collector:4318), so it is unusable
// for APP_URL/WEB_URL/OTEL_EXPORTER_OTLP_ENDPOINT in this schema.
// z.url({ protocol: /^https?$/ }) keeps the "http or https only" restriction
// while accepting any hostname, including localhost.
const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug'])

const AppEnvSchema = z.enum(['local', 'dev', 'qa', 'prod'])

/**
 * The deployment an `APP_ENV` value names.
 */
export type AppEnv = z.infer<typeof AppEnvSchema>

const TOP_LEVEL_LABEL = /^[a-z]{2,}$/

/**
 * Whether `value` is a lowercase domain: a dotted hostname by
 * `EMAIL_DOMAIN_PATTERN`, the shape the audit log stores for an auto-join,
 * whose last label is two or more letters.
 * @param value - One trimmed entry of PLATFORM_EMAIL_DOMAINS.
 * @returns True for a domain such as `example.com`.
 */
function isLowercaseDomain(value: string): boolean {
  return EMAIL_DOMAIN_PATTERN.test(value) && TOP_LEVEL_LABEL.test(value.split('.').at(-1) ?? '')
}

const EnvSchema = z.object({
  // Both required, with no default: a deploy that forgets to name its
  // environment refuses to boot instead of quietly running with local
  // settings. `.meta({ example })` is what `pnpm env:example` writes as the
  // value, since a required field has no default to write.
  APP_ENV: AppEnvSchema.describe(
    'Which deployment this is: local, dev, qa or prod. Required. COOKIE_SECURE and LOG_FORMAT default from it, and SMTP requires TLS everywhere but local.'
  ).meta({ example: 'local' }),
  // Kept alongside APP_ENV because Express reads it itself (app.get('env')):
  // only `production` hides stack traces in Express's built-in error handler.
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .describe(
      'Node runtime mode: development, test or production. Required. Express reads it directly, and only production hides stack traces in its built-in error handler, so every APP_ENV but local must run production. test is for the test suite.'
    )
    .meta({ example: 'development' }),
  APP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(4040)
    .describe('Port the HTTP server listens on. Defaults to 4040.'),

  // FORMER PLACEHOLDERS. APP_URL and SESSION_SECRET used to be forward
  // declarations for the CORS/session plans (see SECURITY.md, "Intended
  // choices") that nothing in src/ read yet. Both are read now:
  // passport.config.ts's `configurePassport()` reads `APP_URL` to build the
  // Google OAuth `callbackURL`, and `createOAuthSessionMiddleware()` reads
  // `SESSION_SECRET` to sign the express-session cookie used for the OAuth
  // round-trip's CSRF `state` parameter — so each field's own `.describe()`
  // below says what it actually does rather than carrying the placeholder
  // note. WEB_URL was the first of these to graduate —
  // verification.service.ts reads `getEnv().WEB_URL` to build the
  // link mailed to a user, and it now has a second reader:
  // origin.utilities.ts reads it to decide whether a browser's Origin
  // header may receive a CORS grant. JWT_ACCESS_SECRET graduated earlier still —
  // session.service.ts (signAccessToken/verifyAccessToken) reads it to sign
  // and verify every access token.
  //
  // There is no JWT_REFRESH_SECRET: refresh tokens are opaque random
  // strings, not JWTs (session.service.ts's header comment), so nothing
  // signs one with a secret, ever — not "not yet". A field that can never
  // be read is not a placeholder, it is exactly the friction a boilerplate
  // should not ship: a cloner generating a 32-character secret for a
  // mechanism that does not exist.
  //
  // The remaining placeholders stay REQUIRED rather than optional on
  // purpose: a downstream project that adds the feature they reserve
  // should hit a named, fail-fast error at boot for a missing secret, not
  // discover at runtime that it signed something with `undefined`. The
  // cost of that choice is a cloner generating a handful of 32-character
  // strings before anything boots, so each `.describe()` below says
  // plainly that any 32-character string will do for now — the
  // description is what `pnpm env:example` writes into .env.example as a
  // comment, so this is the one place that can tell them without
  // drifting.
  APP_URL: z
    .url({ protocol: /^https?$/ })
    .describe(
      'Public origin of this API. Used to build the Google OAuth callback URL (passport.config.ts) — must match a redirect URI registered in Google Cloud Console exactly, including scheme and trailing slash. http://localhost:4040 locally.'
    ),
  WEB_URL: z
    .url({ protocol: /^https?$/ })
    .describe(
      'Public origin of the frontend. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.'
    ),

  DATABASE_URL: z
    .url()
    .describe(
      'Postgres connection URL. The compose stack publishes Postgres on localhost:5433: postgres://boilerplate:boilerplate@localhost:5433/boilerplate.'
    ),
  REDIS_URL: z
    .url()
    .describe(
      'Redis connection URL. The compose stack publishes Redis on localhost:6380: redis://localhost:6380.'
    ),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(10)
    .describe(
      "Most open connections in the Postgres pool, per process. Defaults to 10. The test suite sets 2, so its parallel workers stay under Postgres's default 100 connections."
    ),
  // 0 is allowed: databaseClientOptions() then sends no statement_timeout,
  // so the server's own setting (by default none) applies.
  DB_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30_000)
    .describe(
      "Milliseconds a single SQL statement may run before Postgres cancels it (statement_timeout). Defaults to 30000 (30s). 0 sends no limit, leaving the server's own setting. A statement_timeout in DATABASE_URL's query string overrides it. PgBouncer, in every pool mode, refuses a startup parameter not listed in its ignore_startup_parameters, so behind it set 0 or list statement_timeout there."
    ),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32)
    .describe(
      'Signs and verifies access tokens (session.service.ts). Any 32+ character string works; use `openssl rand -hex 32`.'
    ),
  SESSION_SECRET: z
    .string()
    .min(32)
    .describe(
      'Signs the express-session cookie used during the Google OAuth round-trip (passport.config.ts). Any 32+ character string works; use `openssl rand -hex 32`.'
    ),

  // Both OPTIONAL, deliberately, even though Google login only works when
  // BOTH are set together — Zod cannot express "required together" with a
  // schema-level `.refine()` here: `getDatabaseUrl()`'s own comment already
  // establishes that ANY `.refine()` on `EnvSchema` itself breaks
  // `EnvSchema.pick(...)`, which drizzle-kit's entry point depends on. The
  // pairing is instead enforced in code, at strategy-registration time
  // (`configurePassport()`, passport.config.ts): absent `GOOGLE_CLIENT_ID`
  // disables Google login entirely (no route mounted), and `GOOGLE_CLIENT_ID`
  // set without `GOOGLE_CLIENT_SECRET` throws at boot — the same
  // refuse-to-start posture `trustProxySetting`'s own comment describes for
  // a different misconfiguration.
  GOOGLE_CLIENT_ID: z
    .string()
    .optional()
    .describe('Google OAuth 2.0 client ID. When absent, Google login is disabled.'),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .optional()
    .describe('Google OAuth 2.0 client secret. Required when GOOGLE_CLIENT_ID is set.'),

  // Validated with a refinement that actually CALLS ms() and checks its
  // result, rather than a regex that merely looks duration-shaped. This is
  // the exact defect this repository was rebuilt to remove: the old
  // codebase called `ms(process.env.REFRESH_TOKEN_EXPIRY)` directly at
  // module-import time with the variable unset, `ms()` threw, and that took
  // down an unrelated test suite before any test body ran — one test passed
  // in the entire backend, and the failure named a third-party library
  // rather than the missing variable. Here an unparseable value fails at
  // boot, inside safeParse, named alongside every other invalid variable —
  // never as a throw reaching out of this module.
  //
  // Since session-revocation, this value also sets the TTL of a denylist
  // entry written by session-denylist.service.ts's denySession — read
  // there by the DENYING pod at the moment of denial, not by the pod that
  // originally minted the token. A rolling deploy that CHANGES this value
  // therefore mixes minter's-env and denier's-env for tokens in flight
  // during the rollout: raising 15m -> 60m lets an old-env pod, still
  // running denySession with the old value, write a 15-minute denylist
  // entry against a token a new-env pod already minted with a 60-minute
  // life — the entry expires before the token does, and the token becomes
  // usable again for the remainder of its life. Within one consistent env
  // (the ordinary case between deploys) the scheme stays
  // conservative-correct: see session-denylist.service.ts's own comment
  // for why the entry then always outlives the token it targets.
  ACCESS_TOKEN_TTL: z
    .string()
    .default('15m')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message: 'ACCESS_TOKEN_TTL must be a duration string ms() can parse, e.g. "15m" or "900000".',
    })
    .describe(
      'Access token lifetime, as an ms()-parseable duration string (e.g. "15m"). Defaults to 15m.'
    ),
  REFRESH_TOKEN_TTL: z
    .string()
    .default('30d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'REFRESH_TOKEN_TTL must be a duration string ms() can parse, e.g. "30d" or "2592000000".',
    })
    .describe(
      'Refresh token lifetime, as an ms()-parseable duration string (e.g. "30d"). Defaults to 30d.'
    ),

  // The ABSOLUTE cap on one login session, measured from when it started
  // and never reset. REFRESH_TOKEN_TTL above is a SLIDING window: every
  // rotation issues a token with a fresh expiry, so a client refreshing
  // normally (every 15 minutes, as ACCESS_TOKEN_TTL implies) never lets one
  // expire and the session lives forever — and so does an exfiltrated
  // refresh cookie, until someone happens to log out.
  //
  // Defaulted to the same 30d as REFRESH_TOKEN_TTL so the two agree out of
  // the box: a session lasts at most as long as a single un-rotated refresh
  // token would have. They are independent knobs, though — raising
  // REFRESH_TOKEN_TTL (how long a client may be idle) does not raise this
  // (how long a session may live at all), which is the point of having
  // both.
  SESSION_ABSOLUTE_TTL: z
    .string()
    .default('30d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'SESSION_ABSOLUTE_TTL must be a duration string ms() can parse, e.g. "30d" or "2592000000".',
    })
    .describe(
      'Hard ceiling on one login session, measured from the login itself and never reset by rotation, as an ms()-parseable duration string (e.g. "30d"). Past it, refreshing fails and the user signs in again. Defaults to 30d.'
    ),

  // How long an email-verification link stays valid, from issue to click.
  // Same `parseDurationMs` validation as ACCESS_TOKEN_TTL/REFRESH_TOKEN_TTL/
  // SESSION_ABSOLUTE_TTL above — one helper for "is this an ms()-parseable
  // duration", not a second inline refinement repeating the same check.
  // Defaulted to 24h rather than something short-lived like ACCESS_TOKEN_TTL:
  // a verification email is read on the user's own schedule, not machine
  // speed, and a link the user finds the next morning should still work.
  EMAIL_VERIFICATION_TTL: z
    .string()
    .default('24h')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'EMAIL_VERIFICATION_TTL must be a duration string ms() can parse, e.g. "24h" or "86400000".',
    })
    .describe(
      'How long an email-verification link stays valid. Defaulted to 24h; a link the user finds the next morning should still work.'
    ),

  // How long a password-reset link stays valid, from issue to click. A
  // SHORTER default than EMAIL_VERIFICATION_TTL, deliberately, despite both
  // being "a link mailed to a user" at a glance: redeeming this one grants
  // immediate account takeover (a new password, plus every existing session
  // revoked) the instant it is claimed, where an email-verification link
  // only ever proves mailbox ownership. A reset link sitting in an inbox (or
  // a mail-server log, or a compromised mail account) for 24h is 24h of
  // takeover exposure; 1h keeps the window closer to how someone actually
  // uses the flow — request it, check mail, click it — while still
  // tolerating a few minutes' delivery lag. A separate variable, not a
  // second purpose reusing EMAIL_VERIFICATION_TTL, so the two can be tuned
  // independently — see this schema's own precedent
  // (ACCESS_TOKEN_TTL/REFRESH_TOKEN_TTL/SESSION_ABSOLUTE_TTL are three
  // separate knobs for the same reason).
  PASSWORD_RESET_TTL: z
    .string()
    .default('1h')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message:
        'PASSWORD_RESET_TTL must be a duration string ms() can parse, e.g. "1h" or "3600000".',
    })
    .describe(
      'How long a password-reset link stays valid. Defaulted to 1h — shorter than EMAIL_VERIFICATION_TTL, because redeeming it grants immediate account takeover rather than merely proving mailbox ownership.'
    ),

  // How long a tenant invitation link stays valid. Same parseDurationMs
  // validation as the other TTLs.
  INVITATION_TTL: z
    .string()
    .default('7d')
    .refine((value) => parseDurationMs(value) !== undefined, {
      message: 'INVITATION_TTL must be a duration string ms() can parse, e.g. "7d" or "604800000".',
    })
    .describe(
      'How long a tenant invitation link stays valid, as an ms()-parseable duration string (e.g. "7d"). Resending an invitation issues a new link with a fresh lifetime. Defaults to 7d.'
    ),

  // How much of `X-Forwarded-For` Express is allowed to believe. There is
  // no safe default in either direction, which is why this is a required
  // decision expressed as configuration rather than a literal in app.ts:
  //
  //   - Too little trust (the default, `false`): behind a proxy,
  //     `request.ip` is the PROXY's address for every request, so every
  //     IP-keyed rate limiter collapses into ONE bucket for the entire
  //     deployment. The refresh limiter's 300-per-5-minutes becomes 300
  //     requests per 5 minutes for all users combined, and one noisy client
  //     denies refresh to everyone.
  //   - Too much trust (`true`, or a hop count larger than the number of
  //     proxies actually in front of this process): `X-Forwarded-For` is
  //     just a request header, so a client that can reach the app can write
  //     whatever it likes into it. Express then reads an attacker-chosen
  //     "client IP", which means a fresh rate-limit bucket on every single
  //     request — the login limiter (5 attempts per 15 minutes) stops
  //     existing.
  //
  // `false` is the default because it FAILS TOWARDS OVER-LIMITING rather
  // than towards no limit at all: an operator who never reads this gets a
  // limiter that is too aggressive behind a proxy, not one that can be
  // bypassed by adding a header. The literal `true` is refused outright —
  // it is the shape of this footgun that gets typed by accident, and every
  // legitimate use of it is expressible as a hop count or an address list.
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine((value) => value.trim().toLowerCase() !== 'true', {
      message:
        'TRUST_PROXY must not be "true": trusting every hop lets any client spoof X-Forwarded-For and bypass the IP-keyed rate limiters. Use the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted addresses/subnets (e.g. "10.0.0.0/8") or presets ("loopback", "uniquelocal").',
    })
    .describe(
      'How much of X-Forwarded-For to believe. "false" (default) trusts none: correct when clients reach this app directly, WRONG behind a proxy, where every IP-keyed rate limiter then shares one bucket for the whole deployment. Behind a proxy set the NUMBER of proxies in front of this app (e.g. "1"), or a comma-separated list of trusted proxy addresses/subnets or presets ("loopback", "linklocal", "uniquelocal"). Never "true" — it is refused, because it lets any client spoof its own IP and bypass the limiters.'
    ),

  // Optional with no schema default on purpose: the default depends on
  // APP_ENV, and only isCookieSecure() below applies it. A plain `.default()`
  // cannot read a sibling field.
  COOKIE_SECURE: z
    .stringbool()
    .optional()
    .describe(
      'Whether the refresh-token and OAuth session cookies carry the Secure attribute ("true" or "false"). Defaults from APP_ENV: false on local, true elsewhere. With Secure on behind a TLS-terminating proxy, TRUST_PROXY must be set, or the OAuth session cookie is never sent.'
    ),
  COOKIE_DOMAIN: z
    .string()
    .refine((value) => !/[\s/:]/.test(value), {
      message:
        'COOKIE_DOMAIN must be a bare domain such as "example.com", with no scheme, port or path.',
    })
    .optional()
    .describe(
      "Domain attribute for the refresh-token and OAuth session cookies, e.g. \"example.com\" to share them with subdomains. Unset means host-only cookies, the narrowest scope. Boot refuses a value that APP_URL's host is not within, since browsers would reject the cookies. With COOKIE_SECURE on, the refresh cookie is __Secure-refreshToken when this is set and __Host-refreshToken (Path=/) when it is not, so setting or unsetting it on a live deployment signs users in again once. With COOKIE_SECURE on, a leftover unprefixed refreshToken cookie is still read, then cleared in its host-only form and under this domain. Within one name the API reads the most recently created cookie. Reverting to an earlier value is the exception: the browser keeps that cookie's original creation time, so the other scope's cookie reads as newer and refresh fails until the user logs in again or it expires."
    ),

  // Extra browser origins allowed to call this API, comma-separated, e.g.
  // "https://admin.example.com,https://shop.example.com". WEB_URL is ALWAYS
  // allowed and does not need listing. Same-origin requests send no Origin
  // header at all and are always allowed. Never a wildcard: `cors` refuses
  // `*` together with `credentials: true`, which this API needs for the
  // refresh cookie.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .describe(
      'Extra browser origins allowed to call this API, comma-separated (e.g. "https://admin.example.com,https://shop.example.com"). WEB_URL is ALWAYS allowed and does not need listing here, and same-origin requests send no Origin header at all. Leave empty for a single-frontend deployment. Never a wildcard: this API sends credentials, and the CORS spec forbids "*" with credentials.'
    ),

  // Grants viewer only, and only to a verified address; anything higher is
  // an explicit grant. Parsed by parsePlatformEmailDomains (platform.service.ts).
  PLATFORM_EMAIL_DOMAINS: z
    .string()
    .refine((value) => value.split(',').every((domain) => isLowercaseDomain(domain.trim())), {
      message:
        'PLATFORM_EMAIL_DOMAINS must be lowercase domains separated by commas, e.g. "example.com,example.org".',
    })
    .optional()
    .describe(
      'Comma-separated email domains, e.g. "example.com,example.org". A user whose verified address is on one of them joins the platform tenant as viewer, when the address is verified and at every sign-in. Viewer can see every tenant and change nothing; a higher platform role needs an explicit grant (pnpm platform:grant, or an invitation to the platform tenant). Only the exact domain after the last "@" matches, never a subdomain. Empty means nobody joins automatically.'
    ),

  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe('Absent means tracing is disabled; the SDK is never started.'),
  // Read directly, never through this schema: src/observability/tracing.ts
  // loads via `--import`, before getEnv() has run, so it reads
  // process.env.OTEL_SERVICE_NAME itself (see that file's own header
  // comment). It is still declared here — same as every other environment
  // variable — so pnpm env:example documents it and a downstream project has
  // exactly one place to look up every variable this app reads. The default
  // is duplicated in tracing.ts's own `?? 'express-boilerplate'` fallback,
  // which is unavoidable given tracing.ts cannot import this module; keep
  // the two in sync by hand if this default ever changes.
  OTEL_SERVICE_NAME: z
    .string()
    .min(1)
    .default('express-boilerplate')
    .describe('Service name reported in OTEL traces.'),
  // `silent` is accepted here and NOT in LogLevelSchema itself: SLACK_LOG_LEVEL
  // shares that schema, and logger.service.ts's toPinoLevel() maps an unknown
  // stream level to 'info' — so a `silent` Slack level would have sent
  // everything from info up to Slack. .env.test sets LOG_LEVEL=silent so the
  // suite's deliberate failure paths do not flood the output.
  LOG_LEVEL: z
    .enum([...LogLevelSchema.options, 'silent'])
    .default('info')
    .describe(
      'Console log level: error, warn, info or debug. silent disables logging entirely (the test suite uses it).'
    ),
  // Optional with no schema default, for the same reason as COOKIE_SECURE:
  // logFormat() below derives it from APP_ENV.
  LOG_FORMAT: z
    .enum(['json', 'pretty'])
    .optional()
    .describe(
      'Console log format: json or pretty. Defaults from APP_ENV: pretty on local, json elsewhere. pretty needs the pino-pretty devDependency; without it the logger writes json.'
    ),

  SLACK_WEBHOOK_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .describe(
      'Slack Incoming Webhook URL for log alerting. When unset, no Slack transport is registered.'
    ),
  SLACK_LOG_LEVEL: LogLevelSchema.default('error').describe(
    'Minimum log level that triggers a Slack notification. Defaults to error; set to warn if you want Slack alerts for warnings too.'
  ),

  // z.stringbool(), NOT z.coerce.boolean(): `Boolean("false")` is `true` in
  // JavaScript, so z.coerce.boolean() (which coerces via `Boolean(value)`)
  // would make `WORKER_ENABLED=false` in a .env file silently ENABLE the
  // worker — the exact opposite of what an operator wrote. z.stringbool()
  // (Zod 4) parses the string content itself ("false"/"0"/"no" -> false,
  // "true"/"1"/"yes" -> true), which is what a boolean-shaped env var
  // actually needs.
  WORKER_ENABLED: z
    .stringbool()
    .default(true)
    .describe(
      'Whether the BullMQ workers (email, notification and maintenance) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true. The daily retention purge runs only where this is true.'
    ),
  WORKER_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      'Jobs the email and notification workers each process at once, per process. Defaults to 5. The maintenance worker always runs one job at a time.'
    ),
  // Retention windows for the daily purge (retention.service.ts), in whole
  // days. 0 turns a rule off. Only a process with WORKER_ENABLED runs it.
  RETENTION_TOKENS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(7)
    .describe(
      'Days to keep a user_tokens row once it has expired, or once it was revoked without ever being used (logout, reuse, password change). A token rotated away is kept until it expires, because reuse detection needs it. 0 never purges. Defaults to 7.'
    ),
  RETENTION_INVITATIONS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(30)
    .describe(
      'Days to keep a tenant invitation after the latest of its expiry, acceptance and revocation. 0 never purges. Defaults to 30.'
    ),
  RETENTION_EMAIL_LOGS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(90)
    .describe(
      'Days to keep an email_logs row (one per email sent or failed). 0 never purges. Defaults to 90.'
    ),
  RETENTION_NOTIFICATIONS_READ_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(90)
    .describe('Days to keep a notification after it was read. 0 never purges. Defaults to 90.'),
  RETENTION_NOTIFICATIONS_UNREAD_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(365)
    .describe(
      'Days to keep a notification nobody read, counted from when it was created. 0 never purges. Defaults to 365.'
    ),
  RETENTION_AUDIT_LOGS_DAYS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      'Days to keep an audit_logs row. Defaults to 0, which keeps the audit log forever. Set a number of days only where your compliance rules allow deleting audit history.'
    ),
  // Every Redis key and channel goes through redisKey() (redis.service.ts),
  // which joins this and its parts with ':'. A trailing colon would double it.
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9:_-]*$/, 'Use lowercase letters, digits, ":", "_" and "-"')
    .refine((value) => !value.endsWith(':'), 'No trailing colon: keys are joined with ":"')
    .default('express-boilerplate')
    .describe(
      'Namespace for every Redis key and channel this app uses: BullMQ queues (`<prefix>:bull`), rate-limit counters (`<prefix>:rl`), the session denylist (`<prefix>:denylist`), OAuth sessions (`<prefix>:sess`) and the notification channel (`<prefix>:notifications`). Lowercase letters, digits, ":", "_" and "-", with no trailing colon. Give each app or environment sharing one Redis its own value; changing it abandons every existing key.'
    ),

  // How often notification-stream.controller.ts writes a `:ping\n\n` comment
  // line to an open SSE connection, to keep it alive through an intermediary
  // (a load balancer, an nginx proxy) that would otherwise time out an
  // idle-looking socket. Was a hardcoded 30_000 constant in that controller;
  // pulled into this schema so .env.test can set it to something short —
  // waiting on a real 30-second `setInterval` made
  // tests/integration/api/notification-stream.test.ts's own heartbeat test
  // the single slowest thing in the entire suite. Defaulted to 30s, matching
  // the former hardcoded value.
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(
      'Milliseconds between `:ping` heartbeat comments on an open notification SSE stream (notification-stream.controller.ts). Defaults to 30000 (30s).'
    ),
  // Caps open notification streams per user in THIS process (the registry is
  // in-memory, lifecycle.service.ts). Bounds file descriptors and emitter
  // listeners one account can hold open.
  SSE_MAX_STREAMS_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      'Most notification SSE streams one user may hold open at once, per process. A request over the cap gets 429 too_many_streams. Defaults to 5 (several tabs and devices).'
    ),

  // SMTP configuration for mailer.service.ts (src/services/mailer.service.ts)
  // / mailer.config.ts. Defaulted to docker-compose.yml's Mailpit service
  // (SMTP on 1025) so a fresh clone can send mail with zero configuration —
  // the same reasoning TRUST_PROXY/ACCESS_TOKEN_TTL use for their own
  // defaults, and unlike DATABASE_URL/REDIS_URL, where a wrong default would
  // point at a real dependency silently. Mailpit does not require or check
  // SMTP_USERNAME/SMTP_PASSWORD at all, which is exactly why they stay optional with
  // no default rather than joining APP_URL/WEB_URL's required-placeholder
  // pattern: a real provider (SES, SendGrid, ...) needs both, and a
  // downstream project sets them then, not before.
  SMTP_HOST: z
    .string()
    .min(1)
    .default('localhost')
    .describe(
      'SMTP server host. Defaults to localhost, where the compose Mailpit service listens.'
    ),
  SMTP_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(1025)
    .describe("SMTP server port. Defaults to 1025 — Mailpit's SMTP port."),
  SMTP_USERNAME: z
    .string()
    .optional()
    .describe(
      'SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers. Set it together with SMTP_PASSWORD: boot refuses one without the other.'
    ),
  SMTP_PASSWORD: z
    .string()
    .optional()
    .describe(
      'SMTP password. Set it together with SMTP_USERNAME: boot refuses one without the other.'
    ),
  // The pair is not cross-validated here with a schema-level .refine():
  // EnvSchema.pick({ DATABASE_URL: true }) (getDatabaseUrl, below) throws
  // "cannot be used on object schemas containing refinements" the moment ANY
  // .refine() sits on the object itself, which would break drizzle-kit's one
  // entry point into this file. assertEnvConsistent (env-consistency.config.ts)
  // refuses a half-set pair at boot instead.
  MAIL_FROM: z
    .email()
    .default('no-reply@example.com')
    .describe(
      'The From address on every outbound email. Mailpit accepts any value; a real provider may require this to be a verified sender.'
    ),

  // The product name in email copy and notification text. Callers read
  // `getEnv().APP_NAME` and pass it to a template as `appName`, so the
  // templates stay pure functions. Defaulted: a product name carries no
  // security consequence, so there is no reason to fail boot without one.
  APP_NAME: z
    .string()
    .min(1)
    .default('Express Boilerplate')
    .describe(
      'Product name in outbound email copy and notification text: verification, password reset, password changed and invitation messages (auth.service.ts, verification.service.ts, tenant-invitation.service.ts). Defaults to "Express Boilerplate".'
    ),

  // These three bound the stages of a send to an SMTP host that stops
  // responding. SMTP_CONNECTION_TIMEOUT_MS is also nodemailer's dnsTimeout,
  // which bounds only the first try of each DNS query. nodemailer's own defaults (smtp-connection)
  // are 2 minutes (connectionTimeout), 30 seconds (greetingTimeout and
  // dnsTimeout) and 10 minutes (socketTimeout, an inactivity timer).
  //
  // No HTTP response waits on SMTP: every send runs in email.worker.ts off
  // the queue, and forgot-password answers 202 before it even looks the user
  // up, so latency cannot reveal whether an address is registered. What the
  // timeouts shorten is (1) how long a hung send holds an email-worker slot,
  // and (2) how long it delays graceful shutdown: gracefulShutdown
  // (server.ts) drains HTTP for up to SERVER_DRAIN_TIMEOUT_MS, then waits
  // for the in-flight job before closing the database, Redis and queues and
  // flushing traces.
  //
  // They are per-stage bounds, not a per-send deadline. The resolver retries
  // a DNS query that times out and doubles the timeout on each retry, so at
  // the 3000 ms default one address family can take about 45s; when neither
  // family returns an address, nodemailer falls back to the OS resolver,
  // which has no timeout. A host that resolves
  // to several addresses can take the connection timeout once per address.
  // A server that keeps sending bytes resets the inactivity timer. The boot
  // check in env-consistency.config.ts sums connect, greeting and inactivity
  // for one address against SHUTDOWN_TIMEOUT_MS: a sanity check, not a
  // guarantee. With the defaults that sum is 15s, which with the 5s drain
  // leaves 5s of the default 25s budget.
  //
  // The compose Mailpit sends its greeting in 8–16 ms (3 raw-socket runs),
  // so 5000 ms leaves ample margin. If the real-Mailpit integration tests
  // time out on the greeting, raise SMTP_GREETING_TIMEOUT_MS in .env.test and
  // the CI env block, not this default.
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3000)
    .describe(
      "Milliseconds to wait for each SMTP connection attempt to establish before failing. Also the timeout for the first try of each DNS query; the resolver doubles it on each retry, and the OS-lookup fallback has no timeout. A host that resolves to several addresses can take it once per address. Boot checks that it plus SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS and the 5s HTTP drain stays at least 5s under SHUTDOWN_TIMEOUT_MS; that assumes one address and is a sanity check, not a per-send deadline. nodemailer's own defaults are 2 minutes to connect and 30 seconds per DNS query."
    ),
  SMTP_GREETING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000)
    .describe(
      "Milliseconds to wait for the SMTP server's greeting after connecting. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 30 seconds."
    ),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7000)
    .describe(
      "Milliseconds of inactivity before an open SMTP connection is closed. Counts toward the shutdown budget — see SMTP_CONNECTION_TIMEOUT_MS. nodemailer's own default is 10 minutes."
    ),

  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(25_000)
    .describe(
      "Milliseconds graceful shutdown may take before the process exits with code 1 anyway. Defaults to 25000, under Kubernetes' default 30s termination grace period."
    ),
})

/**
 * The validated, frozen environment every module consumes.
 */
export type Env = Readonly<z.infer<typeof EnvSchema>>

/**
 * The schema's field map, exported so `pnpm env:example` can walk it.
 */
export const EnvSchemaShape = EnvSchema.shape

/**
 * Validate an environment source and return it typed and frozen.
 * @param source - Raw key/value pairs, normally `process.env`.
 * @returns The parsed environment.
 * @throws {Error} Listing every invalid or missing variable at once.
 */
export function parseEnv(source: Record<string, unknown>): Env {
  // Drop empty-string values before validating. A .env produced by copying
  // .env.example leaves `KEY=` lines behind, and '' is not the same as
  // absent to an `.optional()` field — it fails as a malformed URL instead
  // of being treated as unset. dotenv has no other way to express "unset",
  // so an empty value means absent here. Required fields are unaffected:
  // they still fail, now with a "missing" message instead of a confusing
  // format error.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
  const result = EnvSchema.safeParse(present)

  if (!result.success) {
    // prettifyError renders every issue with its path, so a developer fixes
    // all of them in one pass instead of one per restart.
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }

  return Object.freeze(result.data)
}

/**
 * Parse `process.env` once and memoise the result.
 *
 * Lazy on purpose: a module-scope `parseEnv(process.env)` would throw during
 * import resolution, which is the failure mode this module exists to remove.
 * The memoisation cache lives inside this IIFE's closure rather than as a
 * top-level module variable, so the reassignment on every call is local to
 * the function that owns it (satisfying
 * unicorn/no-top-level-assignment-in-function without disabling it) while
 * the memoisation behaviour is unchanged.
 * @returns The validated environment.
 */
export const getEnv: () => Env = (() => {
  let cached: Env | undefined
  return (): Env => {
    cached ??= parseEnv(process.env)
    return cached
  }
})()

/**
 * Translate `TRUST_PROXY` into the value Express's `trust proxy` setting
 * expects.
 *
 * Kept here, next to the variable it interprets, rather than inline in
 * app.ts — that is what lets it be unit-tested without importing `@/app`,
 * which reaches `database.service.ts` at module scope. The mapping is
 * deliberately total and dumb: `"false"` disables it, a whole number is a
 * hop count, and anything else is handed to Express verbatim as an address
 * list, which `proxy-addr` parses and REJECTS by throwing — at boot, from
 * `createApp()`, not on the first request. That is the intended behaviour
 * for a typo in a security-relevant setting: a process that refuses to
 * start, rather than one silently running with the wrong idea of who its
 * clients are.
 *
 * `"true"` never reaches here — `EnvSchema` refuses it; see that field's
 * comment.
 * @param value - The validated `TRUST_PROXY` value.
 * @returns `false`, a hop count, or the address list to hand to `app.set('trust proxy', ...)`.
 */
export function trustProxySetting(value: string): boolean | number | string {
  const normalised = value.trim()
  if (normalised.toLowerCase() === 'false') return false
  return /^\d+$/.test(normalised) ? Number(normalised) : normalised
}

/**
 * Whether the auth cookies (refresh token, OAuth session) carry `Secure`.
 *
 * The one place the rule lives: an explicit COOKIE_SECURE wins, otherwise
 * every APP_ENV but `local` is secure.
 * @param env - The COOKIE_SECURE and APP_ENV slice of the validated environment.
 * @returns True when the cookies must only travel over HTTPS.
 */
export function isCookieSecure(env: Pick<Env, 'COOKIE_SECURE' | 'APP_ENV'>): boolean {
  return env.COOKIE_SECURE ?? env.APP_ENV !== 'local'
}

/**
 * Console log format: an explicit LOG_FORMAT wins, otherwise `pretty` on
 * local and `json` everywhere else.
 * @param env - The LOG_FORMAT and APP_ENV slice of the validated environment.
 * @returns The format the logger writes.
 */
export function logFormat(env: Pick<Env, 'LOG_FORMAT' | 'APP_ENV'>): 'json' | 'pretty' {
  return env.LOG_FORMAT ?? (env.APP_ENV === 'local' ? 'pretty' : 'json')
}

/**
 * Whether SMTP must upgrade to TLS rather than only negotiating it when the
 * server offers it. Off on local only, where Mailpit cannot speak TLS.
 * @param env - The APP_ENV slice of the validated environment.
 * @returns True on every APP_ENV but `local`.
 */
export function requiresSmtpTls(env: Pick<Env, 'APP_ENV'>): boolean {
  return env.APP_ENV !== 'local'
}

/**
 * Validate and return only `DATABASE_URL`, without requiring the rest of the
 * schema.
 *
 * `drizzle.config.ts` needs a connection string to generate or run
 * migrations — nothing else. Routing it through `getEnv()` would force every
 * `drizzle-kit` invocation to also supply JWT/session secrets that have
 * nothing to do with migrations, which is both a false dependency and an
 * annoyance in CI. `EnvSchema.pick(...)` re-slices the same schema `getEnv`
 * uses, so the validation rule for `DATABASE_URL` itself — currently
 * `z.url()` — stays single-sourced between the two entry points.
 * @returns The validated `DATABASE_URL`.
 * @throws {Error} When `DATABASE_URL` is missing or not a valid URL.
 */
export function getDatabaseUrl(): string {
  const result = EnvSchema.pick({ DATABASE_URL: true }).safeParse(process.env)

  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }

  return result.data.DATABASE_URL
}
