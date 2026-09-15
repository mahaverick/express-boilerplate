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

  // PLACEHOLDERS. Four of the required variables below are still read by
  // nothing in src/ today — verified by grep: APP_URL, WEB_URL,
  // JWT_REFRESH_SECRET and SESSION_SECRET are forward declarations for the
  // auth/CORS/email plans (see SECURITY.md, "Intended choices"), not
  // evidence that any of it exists. JWT_ACCESS_SECRET is the exception —
  // token.utilities.ts (signAccessToken/verifyAccessToken) reads it to sign
  // and verify every access token, so its own `.describe()` below says what
  // it actually does rather than carrying the same placeholder note.
  //
  // They stay REQUIRED rather than optional on purpose: a downstream project
  // that adds auth should hit a named, fail-fast error at boot for a missing
  // secret, not discover at runtime that it signed tokens with `undefined`.
  // The cost of that choice is a cloner generating three 32-character strings
  // before anything boots, so each `.describe()` below says plainly that any
  // 32-character string will do for now — the description is what `pnpm
  // env:example` writes into .env.example as a comment, so this is the one
  // place that can tell them without drifting.
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
  // Still a PLACEHOLDER, but not because auth hasn't shipped — this plan's
  // refresh tokens are deliberately opaque random strings, not JWTs (see
  // token.utilities.ts's header comment), so nothing ever signs one with
  // this secret. Kept for a project that reverses that choice.
  JWT_REFRESH_SECRET: z
    .string()
    .min(32)
    .describe(
      'PLACEHOLDER — refresh tokens are opaque, not JWTs, so nothing reads this. Any 32+ character string works for now; use `openssl rand -hex 32` if a future project signs refresh tokens instead.'
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
