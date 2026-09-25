// src/constants/rate-limit.constants.ts
//
// The 19 rate-limit specs this API enforces, and the key-derivation
// functions `createRateLimiter` (rate-limit.middleware.ts) maps `keyBy` to.
// Moved here, not left in the middleware, because `loginRateLimitKey` (the
// one composite key) must be constructible without importing
// `rate-limit.middleware.ts` — that file imports `RATE_LIMITS` from here,
// and `import-x/no-cycle` (eslint.config.mjs) is `'error'` repo-wide.
//
// name IS the live Redis key prefix (`redisKey('rl', name)`,
// rate-limit.middleware.ts's `limiterStore`). Changing any `name` below
// resets that limiter's counters in every running deployment on the next
// release — tests/unit/constants/rate-limit.constants.test.ts pins the
// full list and order.
//
// Every limiter shares one 429 body/handler (rate-limit.middleware.ts's
// `createRateLimiter`) and `standardHeaders: true` / `legacyHeaders: false`
// — neither varies per limiter today, so `message` is the identical
// literal on all 19 rather than 19 independent copies that could drift.
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
   * How the counting key is derived — see this file's own header comment
   * for what each option maps to.
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
 * normalised the same way `emailSchema` (auth.validators.ts) normalises a
 * valid* one, so "Foo@Example.com" and "foo@example.com" share one bucket.
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
 * submitted email, never either alone — see ARCHITECTURE.md/SECURITY.md for
 * why a distributed attacker (many IPs) or a bystander (same IP, different
 * email) must each land in a different bucket from the victim.
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
  register: {
    name: 'register',
    windowMs: 60 * 60 * 1000,
    limit: 100,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  login: {
    name: 'login',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyBy: loginRateLimitKey,
    message: RATE_LIMITED_MESSAGE,
  },
  loginIp: {
    name: 'login-ip',
    windowMs: 15 * 60 * 1000,
    limit: 100,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  loginAccount: {
    name: 'login-account',
    windowMs: 60 * 60 * 1000,
    limit: 100,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  refresh: {
    name: 'refresh',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  logout: {
    name: 'logout',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  verifyEmail: {
    name: 'verify-email',
    windowMs: 15 * 60 * 1000,
    limit: 30,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  resendVerificationIp: {
    name: 'resend-verification-ip',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  resendVerificationEmail: {
    name: 'resend-verification-email',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  forgotPasswordIp: {
    name: 'forgot-password-ip',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  forgotPasswordEmail: {
    name: 'forgot-password-email',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'email',
    message: RATE_LIMITED_MESSAGE,
  },
  resetPassword: {
    name: 'reset-password',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  googleOAuth: {
    name: 'google-oauth',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  googleOAuthCallback: {
    name: 'google-oauth-callback',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  createTenant: {
    name: 'create-tenant',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  inviteTenantMember: {
    name: 'invite-tenant-member',
    windowMs: 60 * 60 * 1000,
    limit: 30,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  changePassword: {
    name: 'change-password',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  invitationPreview: {
    name: 'invitation-preview',
    windowMs: 15 * 60 * 1000,
    limit: 60,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  invitationAccept: {
    name: 'invitation-accept',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
}
