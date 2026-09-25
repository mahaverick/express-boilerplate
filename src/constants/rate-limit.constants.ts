// src/constants/rate-limit.constants.ts
//
// The 19 rate-limit specs this API enforces, and the key-derivation
// functions `createRateLimiter` (rate-limit.middleware.ts) maps `keyBy` to.
// The key-derivation functions live here, not in rate-limit.middleware.ts,
// because `loginRateLimitKey` (the one composite key) must be constructible
// without importing `rate-limit.middleware.ts` — that file imports
// `RATE_LIMITS` from here, and `import-x/no-cycle` (eslint.config.mjs) is
// `'error'` repo-wide.
//
// name IS the live Redis key prefix (`redisKey('rl', name)`,
// rate-limit.middleware.ts's `limiterStore`). Changing any `name` below
// resets that limiter's counters in every running deployment on the next
// release — tests/unit/constants/rate-limit.constants.test.ts pins the
// full list and order.
//
// Every limiter shares one 429 body/handler (rate-limit.middleware.ts's
// `createRateLimiter`) and `standardHeaders: true` / `legacyHeaders: false`
// — neither varies per limiter, so `message` is the identical literal on
// all 19 rather than 19 independent copies that could drift.
//
// This table is the single source of truth for the per-endpoint threat
// model: each entry below carries its own comment for why its window,
// limit and key axis are what they are.
import type { Request } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'

/**
 * One rate limiter's full configuration: window, budget, and how its
 * counting key is derived.
 */
export interface RateLimiterSpec {
  /**
   * The key segment under `redisKey('rl', name)` — the live Redis key
   * prefix. Never change this for a shipped limiter without intending to
   * reset its counters.
   */
  name: string
  /**
   * Milliseconds before an attempt count resets.
   */
  windowMs: number
  /**
   * Attempts allowed within `windowMs` before the limiter answers 429.
   */
  limit: number
  /**
   * How the counting key is derived: `'ip'` uses express-rate-limit's own
   * default key generator (IP only), `'user'` uses
   * `authenticatedUserRateLimitKey`, `'email'` uses
   * `submittedEmailRateLimitKey`, and a function is a custom key generator
   * — used only by `login`'s composite ip+email key.
   */
  keyBy: 'ip' | 'user' | 'email' | ((request: Request) => string)
  /**
   * The message carried in the 429 `HttpError`'s body.
   */
  message: string
}

/**
 * The 19 rate limiters this API mounts, by name.
 */
export type RateLimitName =
  | 'register'
  | 'login'
  | 'loginIp'
  | 'loginAccount'
  | 'refresh'
  | 'logout'
  | 'verifyEmail'
  | 'resendVerificationIp'
  | 'resendVerificationEmail'
  | 'forgotPasswordIp'
  | 'forgotPasswordEmail'
  | 'resetPassword'
  | 'googleOAuth'
  | 'googleOAuthCallback'
  | 'createTenant'
  | 'inviteTenantMember'
  | 'changePassword'
  | 'invitationPreview'
  | 'invitationAccept'

const RATE_LIMITED_MESSAGE = 'Too many attempts. Please try again later.'

/**
 * The lowercase, trimmed email a request body claims, or an empty string
 * when it carries none. Read directly off the raw body — a limiter must
 * key consistently even for a request validation will go on to reject —
 * normalised the same way `emailSchema` (auth.validators.ts) normalises a *valid*
 * one, so "Foo@Example.com" and "foo@example.com" share one bucket.
 * @param request - The incoming request.
 * @returns The normalised email, or an empty string.
 */
function submittedEmail(request: Request): string {
  const body = request.body as Record<string, unknown> | undefined
  const email = body?.email
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/**
 * The composite key `login`'s limiter counts attempts by: client IP AND
 * submitted email, never either alone — see the `login` entry in
 * `RATE_LIMITS` below for why a distributed attacker (many IPs) or a
 * bystander (same IP, different email) must each land in a different
 * bucket from the victim.
 * @param request - The incoming request.
 * @returns A key combining the client's IP and the submitted email.
 */
function loginRateLimitKey(request: Request): string {
  return `${ipKeyGenerator(request.ip ?? 'unknown')}:${submittedEmail(request)}`
}

/**
 * The key an email-keyed limiter counts attempts by: the submitted address
 * ALONE — a composite with IP here would make the budget per-address-PER-IP,
 * which a distributed attacker defeats trivially. Maps `keyBy: 'email'`.
 * @param request - The incoming request.
 * @returns The submitted, normalised email, or an empty string.
 */
export function submittedEmailRateLimitKey(request: Request): string {
  return submittedEmail(request)
}

/**
 * The key a user-keyed limiter counts attempts by: the authenticated
 * caller's id, or `'anonymous'` when unset. The fallback exists purely so a
 * future misordered mount (this limiter running ahead of `requireAuth`)
 * fails SAFE — every such caller collapses onto one shared, MORE restrictive
 * bucket, never a less restrictive one. Maps `keyBy: 'user'`.
 * @param request - The incoming request.
 * @returns The authenticated caller's id, or `'anonymous'`.
 */
export function authenticatedUserRateLimitKey(request: Request): string {
  return request.user?.id ?? 'anonymous'
}

/**
 * The 19 rate-limit specs this API enforces. `name` is the live Redis key
 * prefix — see this file's own header comment before changing one.
 */
export const RATE_LIMITS: Readonly<Record<RateLimitName, RateLimiterSpec>> = {
  /**
   * Keyed on IP alone, not email: an attacker enumerating addresses varies
   * the email on every request by construction, so only an IP key bounds
   * anything. Bounds bcrypt CPU and outbound mail volume — the identical
   * response for a free vs. a taken address already closes the
   * enumeration oracle, not this limiter.
   */
  register: {
    name: 'register',
    windowMs: 60 * 60 * 1000,
    limit: 100,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * The composite ip+email key: email alone would let anyone who merely
   * knows a victim's address lock them out for free; IP alone would let a
   * distributed attacker bypass the limit entirely. Checked first, ahead
   * of loginIp and loginAccount, so a request it rejects never spends
   * either of their budgets.
   */
  login: {
    name: 'login',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyBy: loginRateLimitKey,
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Per-IP, behind the composite key: bounds one IP spraying many accounts
   * (credential stuffing), which the ip+email key alone can't see.
   */
  loginIp: {
    name: 'login-ip',
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Per-account, keyed on the submitted email alone: bounds distributed
   * guessing against one account from many IPs. Limit is deliberately
   * high — locking a victim out still costs an attacker 100 attempts an
   * hour.
   */
  loginAccount: {
    name: 'login-account',
    windowMs: 60 * 60 * 1000,
    limit: 100,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone; volume protection, not a security boundary — a
   * refresh token is 256 bits of randomness, and reuse detection already
   * revokes the whole session on the first replay of an already-rotated
   * token.
   */
  refresh: {
    name: 'refresh',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone; volume protection only, generous on purpose — a
   * 429 here would leave the refresh cookie uncleared.
   */
  logout: {
    name: 'logout',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone: the token is single-use and high-entropy, so
   * there's no per-token budget worth counting — this bounds a client
   * working through many tokens.
   */
  verifyEmail: {
    name: 'verify-email',
    windowMs: 15 * 60 * 1000,
    limit: 30,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * The TIGHT half of a pair with resendVerificationEmail, run in series:
   * a tight per-address budget would itself be the attack (anyone who
   * knows the address could spend it and deny the real owner their mail),
   * so this IP side is what actually stops an attacker.
   */
  resendVerificationIp: {
    name: 'resend-verification-ip',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * The GENEROUS half of the pair with resendVerificationIp: bounds
   * mail-bombing one victim address without letting a mere address-knower
   * exhaust the real owner's own verification budget.
   */
  resendVerificationEmail: {
    name: 'resend-verification-email',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Same tight/generous pair shape as resend-verification, run in series,
   * for the identical reason: the tight IP side is what stops an
   * attacker, since a tight per-address budget would itself be the attack.
   */
  forgotPasswordIp: {
    name: 'forgot-password-ip',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Generous half of the forgotPasswordIp pair: bounds mail-bombing one
   * victim's inbox without letting anyone who merely knows their address
   * deny them their own reset mail.
   */
  forgotPasswordEmail: {
    name: 'forgot-password-email',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone: the token is single-use and high-entropy (256
   * bits), so this bounds a client working through many tokens or
   * malformed attempts, not guessing.
   */
  resetPassword: {
    name: 'reset-password',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone; bounds the Redis session write
   * `createOAuthSessionMiddleware` makes on every hit, not login
   * guessing — Google's own consent screen already gates a real login
   * attempt from reaching this route at all.
   */
  googleOAuth: {
    name: 'google-oauth',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Its own prefix, separate from googleOAuth's — sharing one would let
   * traffic on either step spend the other's budget. Bounds the
   * database/session work this callback route does per call (a lookup,
   * possibly an insert, and a refresh-token issue).
   */
  googleOAuthCallback: {
    name: 'google-oauth-callback',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on the authenticated caller's id, not IP: this route sits
   * behind `requireAuth`, and IP would let one shared office throttle
   * every other user out of creating a tenant, or let an attacker with
   * many IPs but one account bypass the limit entirely.
   */
  createTenant: {
    name: 'create-tenant',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on the authenticated caller's id, same reasoning as
   * createTenant. Shares its budget with the resend-invitation route
   * (tenant.routes.ts) — the limiter is built once and mounted on both.
   */
  inviteTenantMember: {
    name: 'invite-tenant-member',
    windowMs: 60 * 60 * 1000,
    limit: 30,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Budget of 5 per 15 minutes, matching login rather than
   * resetPassword's 10: this is a password oracle (compares a
   * caller-supplied `currentPassword` against the stored hash), so it
   * deserves login's budget. Keyed on the caller's id, not IP, since it
   * runs behind `requireAuth`.
   */
  changePassword: {
    name: 'change-password',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone: a public route, with no caller identity to key on.
   */
  invitationPreview: {
    name: 'invitation-preview',
    windowMs: 15 * 60 * 1000,
    limit: 60,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on IP alone: this limiter runs ahead of `requireAuth`, so no
   * caller identity exists yet when it executes.
   */
  invitationAccept: {
    name: 'invitation-accept',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
}
