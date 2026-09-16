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

// Populate process.env from .env before anything below ever reads it.
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

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(4040),

  // PLACEHOLDERS. Two of the required variables below are still read by
  // nothing in src/ today — verified by grep: APP_URL and SESSION_SECRET
  // are forward declarations for the CORS/session plans (see SECURITY.md,
  // "Intended choices"), not evidence that either exists yet. WEB_URL is no
  // longer one of them — verification-link.utilities.ts reads
  // `getEnv().WEB_URL` to build the link mailed to a user, so its own
  // `.describe()` below says what it actually does rather than carrying the
  // placeholder note too. JWT_ACCESS_SECRET is the other exception —
  // token.utilities.ts (signAccessToken/verifyAccessToken) reads it to sign
  // and verify every access token, so its own `.describe()` below says what
  // it actually does rather than carrying the same placeholder note.
  //
  // There is no JWT_REFRESH_SECRET: refresh tokens are opaque random
  // strings, not JWTs (token.utilities.ts's header comment), so nothing
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
      'Public origin of this API. PLACEHOLDER — nothing reads it yet; reserved for OAuth callbacks and email links. http://localhost:4040 locally.'
    ),
  WEB_URL: z
    .url({ protocol: /^https?$/ })
    .describe(
      'Public origin of the frontend. Email verification links are built from it — the link points at your frontend, which POSTs the token to this API. http://localhost:5173 locally.'
    ),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32)
    .describe(
      'Signs and verifies access tokens (token.utilities.ts). Any 32+ character string works; use `openssl rand -hex 32`.'
    ),
  SESSION_SECRET: z
    .string()
    .min(32)
    .describe(
      'PLACEHOLDER — no session layer ships yet and nothing reads this. Any 32+ character string works for now; use `openssl rand -hex 32` before shipping sessions.'
    ),

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
  LOG_LEVEL: LogLevelSchema.default('info'),

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
      'Whether the BullMQ workers (email + notification) start in-process alongside the HTTP server. Set to false for API-only pods behind a load balancer; a separate worker deployment sets this to true.'
    ),
  QUEUE_PREFIX: z
    .string()
    .min(1)
    .default('bull')
    .describe(
      'BullMQ Redis key prefix. Tests override this per vitest worker to prevent cross-worker job leaks.'
    ),

  // SMTP configuration for mailer.service.ts (src/services/mailer.service.ts)
  // / mailer.config.ts. Defaulted to docker-compose.yml's Mailpit service
  // (SMTP on 1025) so a fresh clone can send mail with zero configuration —
  // the same reasoning TRUST_PROXY/ACCESS_TOKEN_TTL use for their own
  // defaults, and unlike DATABASE_URL/REDIS_URL, where a wrong default would
  // point at a real dependency silently. Mailpit does not require or check
  // SMTP_USER/SMTP_PASS at all, which is exactly why they stay optional with
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
  SMTP_USER: z
    .string()
    .optional()
    .describe(
      'SMTP username. Absent means no authentication is attempted, which is correct for Mailpit and wrong for most real providers — set this alongside SMTP_PASS.'
    ),
  SMTP_PASS: z.string().optional().describe('SMTP password. See SMTP_USER.'),
  // Not cross-validated against SMTP_USER/SMTP_PASS with a schema-level
  // .refine(): EnvSchema.pick({ DATABASE_URL: true }) (getDatabaseUrl, below)
  // throws "cannot be used on object schemas containing refinements" the
  // moment ANY .refine() sits on the object itself — verified empirically —
  // which would break drizzle-kit's one entry point into this file.
  // mailer.config.ts's own comment covers what happens when only one of the
  // two is set (auth is not attempted, same as neither being set).
  MAIL_FROM: z
    .email()
    .default('no-reply@example.com')
    .describe(
      'The From address on every outbound email. Mailpit accepts any value; a real provider may require this to be a verified sender.'
    ),

  // The product name Task 3's email templates (src/templates/email/) put in
  // their subject lines and sign-offs (e.g. "Verify your email for
  // <APP_NAME>") — never hardcoded into a template, per this repo's own
  // "anything configurable goes in this schema" convention. PLACEHOLDER at
  // THIS layer specifically: nothing in src/ calls `getEnv().APP_NAME` yet,
  // because the controller that would (Task 5/6) does not exist in this
  // plan's execution order yet — every template function takes `appName` as
  // an ordinary string argument, not by reading this schema itself, so it
  // stays a pure function with no config dependency of its own to mock in a
  // unit test. Defaulted, unlike APP_URL/WEB_URL's required-placeholder
  // pattern: a product name carries no security consequence the way a
  // missing secret or a wrong CORS origin would, so there is no fail-fast
  // argument for making a cloner set this before anything boots.
  APP_NAME: z
    .string()
    .min(1)
    .default('Express Boilerplate')
    .describe(
      'Product name used in outbound email copy (src/templates/email/). PLACEHOLDER — nothing in src/ reads it yet; reserved for a later task\'s controller to pass into a template\'s appName variable. Defaults to "Express Boilerplate".'
    ),

  // THESE THREE BOUND A TIMING ORACLE, NOT MERELY A RESOURCE LEAK — read
  // this before raising any of them to "fix" a flaky provider.
  //
  // nodemailer's own defaults (smtp-connection) are 2 minutes
  // (connectionTimeout), 30 seconds (greetingTimeout), and 10 minutes
  // (socketTimeout) — all far longer than an HTTP request should ever
  // legitimately take. Left at those defaults, a HUNG (not merely refused)
  // SMTP host makes `sendMail` (mailer.service.ts) block for minutes on
  // whichever branch actually attempts a send. Ruling G (that file's own
  // header comment) already closed the STATUS-CODE version of this leak —
  // a registered address and an unregistered one must answer identically —
  // but forgot-password only sends when the address exists, so an unbounded
  // hang reopens the identical enumeration oracle through LATENCY instead:
  // a registered address blocks for minutes, an unregistered one returns
  // instantly. An attacker does not need to cause the outage, only to
  // measure during one. These defaults bound the worst case to tens of
  // seconds instead of minutes.
  //
  // greetingTimeout specifically is NOT single-digit seconds, and that
  // floor is measured, not guessed: this project's own shared Mailpit
  // container takes ~8.3 seconds to send its greeting (confirmed at the raw
  // TCP socket level — `nc`/a Python socket connects in under 5ms, then
  // waits ~8s for the first byte — almost certainly a reverse-DNS lookup on
  // the connecting address timing out inside the container's network
  // environment before Mailpit proceeds anyway). A first attempt at 5000ms
  // here made the real-Mailpit integration test fail outright — caught by
  // actually running it, not assumed. 15000ms clears that with real margin
  // while staying nowhere near nodemailer's 30-second default.
  SMTP_CONNECTION_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe(
      "Milliseconds to wait for the SMTP connection to establish before failing. Bounds a timing side-channel (see this schema field group's own comment), not just a resource leak — do not raise this to accommodate a slow provider without reading that comment first. nodemailer's own default is 2 minutes."
    ),
  SMTP_GREETING_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000)
    .describe(
      "Milliseconds to wait for the SMTP server's greeting after connecting. Bounds a timing side-channel — see SMTP_CONNECTION_TIMEOUT. nodemailer's own default is 30 seconds; this project's own Mailpit measured at ~8.3s is why this isn't lower."
    ),
  SMTP_SOCKET_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(20_000)
    .describe(
      "Milliseconds of inactivity before an open SMTP connection is closed. Bounds a timing side-channel — see SMTP_CONNECTION_TIMEOUT. nodemailer's own default is 10 minutes."
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
