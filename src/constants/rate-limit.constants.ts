/**
 * @file The rate-limit specs this API enforces, and the key-derivation
 * functions `createRateLimiter` (rate-limit.middleware.ts) maps `keyBy` to.
 * The key functions live here because rate-limit.middleware.ts imports this
 * file, and `import-x/no-cycle` is an error.
 */
import type { Request } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { loginSchema } from '@/validators/auth.validators'

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
   * — used by `login`'s composite ip+email key and `emailWebhook`'s
   * per-provider key.
   */
  keyBy: 'ip' | 'user' | 'email' | ((request: Request) => string)
  /**
   * Which responses spend the budget: `'accepted'` skips any response with
   * status 400 or above, `'rejected'` skips every response below 400.
   * Absent, every request counts.
   */
  counts?: 'accepted' | 'rejected'
  /**
   * A request this returns true for is neither counted nor limited: it
   * passes to the route, whose own validation answers it.
   */
  skip?: (request: Request) => boolean
  /**
   * The message carried in the 429 `HttpError`'s body.
   */
  message: string
}

/**
 * The 29 rate limiters this API defines, by name.
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
  | 'resetPassword'
  | 'googleOAuth'
  | 'googleOAuthCallback'
  | 'createTenant'
  | 'inviteTenantMember'
  | 'changePassword'
  | 'invitationPreview'
  | 'invitationAccept'
  | 'platformSearch'
  | 'authenticatedWrite'
  | 'platformWrite'
  | 'reauthenticate'
  | 'emailWebhook'
  | 'emailWebhookRejected'
  | 'analyticsProxy'
  | 'platformTimeline'
  | 'flagExposure'
  | 'maintenanceStatus'
  | 'maintenanceModeChange'

const RATE_LIMITED_MESSAGE = 'Too many attempts. Please try again later.'

/**
 * Machine-readable code identifying a rate-limited request, carried in the
 * error envelope's `code` field, so a client can branch on it without
 * matching on `message`.
 */
export const RATE_LIMITED_CODE = 'RATE_LIMITED'

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
 * bucket from the victim. The email part is `hashRateLimitIdentity`'s
 * digest, so the Redis key never names an address.
 * @param request - The incoming request.
 * @returns A key combining the client's IP and the submitted email's digest.
 */
function loginRateLimitKey(request: Request): string {
  return `${ipKeyGenerator(request.ip ?? 'unknown')}:${hashRateLimitIdentity(submittedEmail(request))}`
}

/**
 * Whether a login body would fail `loginSchema`, so the route answers it 400
 * without checking a password. `loginAccount` skips it: a malformed request
 * costs the sender no bcrypt work, so counting it would let anyone lock an
 * account out for free.
 * @param request - The incoming request.
 * @returns True when the body is not a well-formed login.
 */
function isMalformedLogin(request: Request): boolean {
  return !loginSchema.safeParse(request.body).success
}

/**
 * The key an email-keyed limiter counts attempts by: the submitted address
 * ALONE — a composite with IP here would make the budget per-address-PER-IP,
 * which a distributed attacker defeats trivially. Maps `keyBy: 'email'`.
 * The address is hashed (`hashRateLimitIdentity`): a key is written for any
 * string submitted, account or not, and must not name it.
 * @param request - The incoming request.
 * @returns The digest of the submitted, normalised email (of `''` when it carries none).
 */
export function submittedEmailRateLimitKey(request: Request): string {
  return hashRateLimitIdentity(submittedEmail(request))
}

/**
 * The key a user-keyed limiter counts attempts by: the authenticated
 * caller's id, or `'anonymous'` when unset, so a limiter mounted ahead of
 * `requireAuth` fails safe onto one shared, more restrictive bucket. Maps
 * `keyBy: 'user'`.
 * @param request - The incoming request.
 * @returns The authenticated caller's id, or `'anonymous'`.
 */
export function authenticatedUserRateLimitKey(request: Request): string {
  return request.user?.id ?? 'anonymous'
}

/**
 * The key `emailWebhook`'s limiter counts requests by: the `:provider` path
 * segment alone, never the IP. A provider posts from a few shared egress
 * addresses, so an IP key would mix providers' budgets and throttle a
 * bounce storm into retries. The route checks that the provider is enabled
 * before this limiter runs, so the key space is the enabled adapters.
 * @param request - The incoming request.
 * @returns The provider name, or an empty string when the route has none.
 */
export function emailWebhookProviderRateLimitKey(request: Request): string {
  const { provider } = request.params
  return typeof provider === 'string' ? provider : ''
}

/**
 * The key `flagExposure`'s limiter counts reports by: the caller's session
 * (the access token's `sid`), which every tab of one sign-in shares; a token
 * with no `sid` falls back to the user's id.
 * Both are prefixed, so a session id can never land in a user's bucket.
 * @param request - The incoming request, after `requireAuth`.
 * @returns `session:<sid>`, `user:<id>`, or `user:anonymous`.
 */
export function flagExposureRateLimitKey(request: Request): string {
  if (request.sessionId !== undefined) return `session:${request.sessionId}`
  return `user:${request.user?.id ?? 'anonymous'}`
}

/**
 * The 29 rate-limit specs this API enforces, each with the reason for its
 * window, limit and key. `name` is the live Redis key prefix
 * (`redisKey('rl', name)`): changing one resets that limiter's counters in
 * every deployment, and tests/unit/constants/rate-limit.constants.test.ts
 * pins the list and order.
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
   * guessing against one account from many IPs. Counts only well-formed
   * attempts that were refused: a malformed body (`isMalformedLogin`) and
   * the owner's own successful sign-ins spend nothing. The limit is
   * deliberately high, and the residual is by design: 100 well-formed wrong
   * passwords an hour, each a bcrypt-checked request (and the composite
   * `login` key holds each IP to 5 per address), still lock the account.
   */
  loginAccount: {
    name: 'login-account',
    windowMs: 60 * 60 * 1000,
    limit: 100,
    keyBy: 'email',
    counts: 'rejected',
    skip: isMalformedLogin,
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
   * The only limiter on forgot-password, keyed on IP alone. There is no
   * per-address limiter: anyone who knows an address could spend one and
   * deny its owner their reset mail. One victim's inbox is bounded instead
   * by a silent per-address mail cooldown (`PASSWORD_RESET_MAIL_COOLDOWN`,
   * `requestPasswordReset`), behind a reply that never changes.
   */
  forgotPasswordIp: {
    name: 'forgot-password-ip',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    keyBy: 'ip',
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
   * Keyed on the caller's id, behind `requireAuth`, as changePassword: an
   * IP key would let anonymous requests from a shared address lock a
   * signed-in invitee out. The token is 256 bits, so this bounds a user
   * working through many tokens, not guessing.
   */
  invitationAccept: {
    name: 'invitation-accept',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on the caller's id: only staff reach it, past requireAuth and
   * requirePlatformRole. 60 a minute is ample for a debounced search box
   * and bounds a script walking every tenant.
   */
  platformSearch: {
    name: 'platform-search',
    windowMs: 60 * 1000,
    limit: 60,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * One shared budget for every authenticated write that has no
   * route-specific limiter of its own: a floor, not a replacement for a
   * tighter limiter. tests/unit/routes/route-limiters.test.ts fails a write
   * route that has no limiter.
   */
  authenticatedWrite: {
    name: 'authenticated-write',
    windowMs: 60_000,
    limit: 60,
    keyBy: 'user',
    message: 'Too many requests, please slow down',
  },
  /**
   * One shared budget for every `/platform` write, keyed on the caller's id:
   * only staff reach it, past requireAuth and requirePlatformRole. 30 a
   * minute is ample for a person working through a support queue and bounds
   * a script walking every user or tenant.
   */
  platformWrite: {
    name: 'platform-write',
    windowMs: 60_000,
    limit: 30,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Budget of 5 per 15 minutes, keyed on the caller's id, as changePassword:
   * `POST /auth/reauthenticate` compares a caller-supplied password against
   * the stored hash, so it gets a password oracle's budget.
   */
  reauthenticate: {
    name: 'reauthenticate',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 3000 a minute per provider: volume protection for a public route that
   * verifies an HMAC before any database work, generous so a bounce storm
   * after a bulk send is not answered 429 and retried. Keyed per provider,
   * see `emailWebhookProviderRateLimitKey`. Counts only accepted requests
   * (status below 400): the route is public, so an unsigned request from
   * anyone must not spend the budget a provider's real events need;
   * `emailWebhookRejected` bounds those.
   */
  emailWebhook: {
    name: 'email-webhook',
    windowMs: 60_000,
    limit: 3000,
    keyBy: emailWebhookProviderRateLimitKey,
    counts: 'accepted',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 60 a minute per IP, counting only responses of 400 or above: the cap on
   * unsigned, forged or malformed webhook traffic from one address. It runs
   * before `emailWebhook`, and a real provider's accepted requests never
   * spend it.
   */
  emailWebhookRejected: {
    name: 'email-webhook-rejected',
    windowMs: 60_000,
    limit: 60,
    keyBy: 'ip',
    counts: 'rejected',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 3000 a minute per IP for `/api/v1/collect`, the PostHog proxy, and no
   * other limiter counts those requests. From posthog-js 1.435: one active
   * tab flushes its event queue every 3 s and replay snapshots ride the same
   * queue under their own batch key, so at most 20 event and 20 snapshot
   * POSTs a minute; heatmaps flush every 5 s (12); flags, identify and the
   * lazily loaded bundles add a few per page load. About 60 a minute per
   * active tab, so 3000 is 50 busy tabs behind one office NAT address. It
   * bounds a client using the proxy as a relay; it is not a security
   * boundary, and PostHog meters its own ingestion.
   */
  analyticsProxy: {
    name: 'analytics-proxy',
    windowMs: 60_000,
    limit: 3000,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * Keyed on the caller's id: only staff admins reach it, past requireAuth
   * and requirePlatformRole. Every request counts, cached or not; the
   * project-wide hourly query budget (timeline-budget.service.ts) bounds the
   * PostHog queries behind it. The router overrides `limit` with
   * `TIMELINE_REQUESTS_PER_MINUTE`; 20 is that variable's default.
   */
  platformTimeline: {
    name: 'platform-timeline',
    windowMs: 60_000,
    limit: 20,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 60 a minute per session for the three `…/flags/exposures` routes. A
   * browser reports each experiment value once per tab session, batched up
   * to 10 keys a request, so an honest tab sends a handful a session. The
   * server re-evaluates every key and dedupes, so this bounds the work a
   * script can cause, not what it can record.
   * Built once in each of the flags, tenant and platform routers: on Redis the
   * three share one budget per session; on the in-memory fallback each counts
   * on its own.
   */
  flagExposure: {
    name: 'flag-exposure',
    windowMs: 60_000,
    limit: 60,
    keyBy: flagExposureRateLimitKey,
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 120 a minute per IP for the public `GET /status/maintenance`: react
   * fetches it once at start and every 30-40 s while `full`, so a busy office
   * NAT address stays far under it, and a script polling it is bounded.
   */
  maintenanceStatus: {
    name: 'maintenance-status',
    windowMs: 60_000,
    limit: 120,
    keyBy: 'ip',
    message: RATE_LIMITED_MESSAGE,
  },
  /**
   * 10 a minute per staff member for `PUT /platform/maintenance-mode`, behind
   * the owner gate and step-up: a person switches maintenance a few times an
   * hour at most, and each change notifies every owner and admin.
   */
  maintenanceModeChange: {
    name: 'maintenance-mode-change',
    windowMs: 60_000,
    limit: 10,
    keyBy: 'user',
    message: RATE_LIMITED_MESSAGE,
  },
}
