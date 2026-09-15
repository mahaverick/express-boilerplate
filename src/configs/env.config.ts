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
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(4040),

  // PLACEHOLDERS. Three of the required variables below are still read by
  // nothing in src/ today — verified by grep: APP_URL, WEB_URL and
  // SESSION_SECRET are forward declarations for the CORS/email/session
  // plans (see SECURITY.md, "Intended choices"), not evidence that any of
  // it exists. JWT_ACCESS_SECRET is the exception — token.utilities.ts
  // (signAccessToken/verifyAccessToken) reads it to sign and verify every
  // access token, so its own `.describe()` below says what it actually
  // does rather than carrying the same placeholder note.
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
      'Public origin of the frontend. PLACEHOLDER — nothing reads it yet; reserved for CORS and redirect targets. http://localhost:5173 locally.'
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
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
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
