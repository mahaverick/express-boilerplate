/**
 * @file The rate-limit specs this API enforces, and the key-derivation
 * functions `createRateLimiter` (rate-limit.middleware.ts) maps `keyBy` to.
 * The key functions live here because rate-limit.middleware.ts imports this
 * file, and `import-x/no-cycle` is an error.
 */
import type { Request } from 'express'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'

/**
 * One rate limiter's configuration: window, budget and counting key.
 */
export interface RateLimiterSpec {
  /**
   * The key segment under `redisKey('rl', name)`, the live Redis key prefix.
   * Changing it for a shipped limiter resets its counters.
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
   * How the counting key is derived: `'ip'` uses express-rate-limit's
   * default key generator (IP only), `'user'` uses
   * `authenticatedUserRateLimitKey`, `'email'` uses
   * `submittedEmailRateLimitKey`, and a function is a custom key generator,
   * as `emailWebhook`'s per-provider key is.
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
   * What the limit counts, named in the 429 `HttpError`'s message:
   * `createRateLimiter`'s handler writes the limit, the window and when to
   * try again, from the `Retry-After` it answers with.
   */
  unit: 'attempts' | 'requests'
}

/**
 * The names of the 31 limiters in `RATE_LIMITS`.
 */
export type RateLimitName =
  | 'refresh'
  | 'logout'
  | 'googleOAuth'
  | 'googleOAuthCallback'
  | 'createTenant'
  | 'inviteTenantMember'
  | 'invitationPreview'
  | 'invitationAccept'
  | 'platformSearch'
  | 'authenticatedWrite'
  | 'platformWrite'
  | 'emailWebhook'
  | 'emailWebhookRejected'
  | 'analyticsProxy'
  | 'flagEvaluate'
  | 'flagExposure'
  | 'maintenanceStatus'
  | 'maintenanceModeChange'
  | 'revokeOtherSessions'
  | 'signInLinkRequest'
  | 'signInLinkVerify'
  | 'invitationVerify'
  | 'stepUpLink'
  | 'passkeyManage'
  | 'passkeySignInOptions'
  | 'passkeySignIn'
  | 'passkeyStepUp'
  | 'billingWrite'
  | 'billingRead'
  | 'billingWebhook'
  | 'billingWebhookRejected'

/**
 * Machine-readable code identifying a rate-limited request, carried in the
 * error envelope's `code` field, so a client can branch on it without
 * matching on `message`.
 */
export const RATE_LIMITED_CODE = 'RATE_LIMITED'

/**
 * The lowercase, trimmed email a request body claims, or an empty string
 * when it carries none. Read off the raw body because a limiter must key
 * consistently even for a request validation will go on to reject, and
 * normalised as `emailSchema` (auth.validators.ts) does, so
 * "Foo@Example.com" and "foo@example.com" share one bucket.
 * @param request - The incoming request.
 * @returns The normalised email, or an empty string.
 */
function submittedEmail(request: Request): string {
  const body = request.body as Record<string, unknown> | undefined
  const email = body?.email
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/**
 * The key an email-keyed limiter counts attempts by: the submitted address
 * alone. Adding the IP would make the budget per address per IP, which a
 * distributed attacker defeats trivially. Maps `keyBy: 'email'`.
 * The address is hashed (`hashRateLimitIdentity`) because a key is written
 * for any string submitted, account or not, and must not name it.
 * @param request - The incoming request.
 * @returns The digest of the submitted, normalised email (of `''` when it carries none).
 */
export function submittedEmailRateLimitKey(request: Request): string {
  return hashRateLimitIdentity(submittedEmail(request))
}

/**
 * The key a user-keyed limiter counts attempts by: the authenticated
 * caller's id, or `'anonymous'` when unset, so a limiter mounted ahead of
 * `requireAuth` falls into one shared bucket for all such callers. Maps
 * `keyBy: 'user'`.
 * @param request - The incoming request.
 * @returns The authenticated caller's id, or `'anonymous'`.
 */
export function authenticatedUserRateLimitKey(request: Request): string {
  return request.user?.id ?? 'anonymous'
}

/**
 * The key `emailWebhook`'s limiter counts requests by: the `:provider` path
 * segment alone, never the IP. The `emailWebhook` budget is sized for one
 * provider's whole bounce storm, so keying by provider gives each provider
 * that budget instead of sharing one across all of them. The route checks that
 * the provider is enabled before this limiter runs, so the key space is the
 * enabled adapters.
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
 * The prefixes keep a session id from ever matching a user's bucket.
 * @param request - The incoming request, after `requireAuth`.
 * @returns `session:<sid>`, `user:<id>`, or `user:anonymous`.
 */
export function flagExposureRateLimitKey(request: Request): string {
  if (request.sessionId !== undefined) return `session:${request.sessionId}`
  return `user:${request.user?.id ?? 'anonymous'}`
}

/**
 * The 31 rate-limit specs this API enforces, each commented with the reason
 * for its window, limit and key. `name` is the live Redis key prefix
 * (`redisKey('rl', name)`): changing one resets that limiter's counters in
 * every deployment, and tests/unit/constants/rate-limit.constants.test.ts
 * pins the list and order.
 */
export const RATE_LIMITS: Readonly<Record<RateLimitName, RateLimiterSpec>> = {
  /**
   * Keyed on IP alone; volume protection, not a security boundary. A
   * refresh token is 256 bits of randomness, and reuse detection revokes
   * the whole session when an already-rotated token is replayed after
   * `REFRESH_REUSE_GRACE_MS`.
   */
  refresh: {
    name: 'refresh',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * Keyed on IP alone; volume protection only, generous on purpose because
   * a 429 here would leave the refresh cookie uncleared.
   */
  logout: {
    name: 'logout',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * Keyed on IP alone. Bounds the Redis session write
   * `createOAuthSessionMiddleware` makes on every hit; this route takes no
   * credentials, so it is not about login guessing.
   */
  googleOAuth: {
    name: 'google-oauth',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * Its own prefix, separate from googleOAuth's: sharing one would let
   * traffic on either step spend the other's budget. Bounds the work this
   * callback does per call: a session write, a lookup, possibly an insert,
   * and a refresh-token issue.
   */
  googleOAuthCallback: {
    name: 'google-oauth-callback',
    windowMs: 5 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * Keyed on the authenticated caller's id, not IP: this route sits
   * behind `requireAuth`, and an IP key would let one shared office
   * throttle every other user out of creating a tenant, or let an attacker
   * with many IPs but one account bypass the limit entirely.
   */
  createTenant: {
    name: 'create-tenant',
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * Keyed on the authenticated caller's id, for the reason given on
   * createTenant. Shares its budget with the resend-invitation route
   * (tenant.routes.ts): the limiter is built once and mounted on both.
   */
  inviteTenantMember: {
    name: 'invite-tenant-member',
    windowMs: 60 * 60 * 1000,
    limit: 30,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * Keyed on IP alone: a public route, with no caller identity to key on.
   */
  invitationPreview: {
    name: 'invitation-preview',
    windowMs: 15 * 60 * 1000,
    limit: 60,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * Keyed on the caller's id, behind `requireAuth`, as createTenant is: an
   * IP key would let anonymous requests from a shared address lock a
   * signed-in invitee out. The token is 256 bits, so this bounds a user
   * working through many tokens, not guessing.
   */
  invitationAccept: {
    name: 'invitation-accept',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    unit: 'attempts',
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
    unit: 'attempts',
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
    unit: 'requests',
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
    unit: 'attempts',
  },
  /**
   * 3000 a minute per provider: volume protection for a public route that
   * verifies the provider's signature before any database work, generous so
   * a bounce storm after a bulk send is not answered 429 and retried. Keyed
   * per provider, see `emailWebhookProviderRateLimitKey`. Counts only
   * accepted requests (status below 400): the route is public, so an
   * unsigned request from anyone must not spend the budget a provider's real
   * events need; `emailWebhookRejected` bounds those.
   */
  emailWebhook: {
    name: 'email-webhook',
    windowMs: 60_000,
    limit: 3000,
    keyBy: emailWebhookProviderRateLimitKey,
    counts: 'accepted',
    unit: 'attempts',
  },
  /**
   * 60 a minute per IP, counting only responses of 400 or above: the cap on
   * unsigned, forged or malformed webhook traffic from one address. It is
   * mounted before `emailWebhook`, and a provider's accepted requests never
   * spend it.
   */
  emailWebhookRejected: {
    name: 'email-webhook-rejected',
    windowMs: 60_000,
    limit: 60,
    keyBy: 'ip',
    counts: 'rejected',
    unit: 'attempts',
  },
  /**
   * 3000 a minute per IP for `/api/v1/collect`, the PostHog proxy; no other
   * limiter counts those requests. By posthog-js 1.435's defaults, one active
   * tab flushes its event queue every 3 s and replay snapshots ride the same
   * queue under their own batch key, so at most 20 event and 20 snapshot
   * POSTs a minute; heatmaps flush every 5 s (12); flags, identify and the
   * lazily loaded bundles add a few per page load. That is about 60 a minute
   * per active tab, so 3000 is 50 busy tabs behind one office NAT address.
   * It bounds a client using the proxy as a relay; it is not a security
   * boundary, and PostHog meters its own ingestion.
   */
  analyticsProxy: {
    name: 'analytics-proxy',
    windowMs: 60_000,
    limit: 3000,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * One staff user's flag evaluations; the limit comes from
   * `FLAG_EVALUATE_REQUESTS_PER_MINUTE`, whose default is 20. Keyed on the
   * caller's id: only staff admins reach it, past requireAuth and
   * requirePlatformRole.
   */
  flagEvaluate: {
    name: 'flag-evaluate',
    windowMs: 60_000,
    limit: 20,
    keyBy: 'user',
    unit: 'attempts',
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
    unit: 'attempts',
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
    unit: 'attempts',
  },
  /**
   * 10 a minute per staff member for `PUT /platform/maintenance-mode`, behind
   * the owner gate and step-up: a person switches maintenance a few times an
   * hour at most, and switching on, escalating or switching off notifies every
   * other owner and admin (a message edit or a de-escalation notifies no one).
   */
  maintenanceModeChange: {
    name: 'maintenance-mode-change',
    windowMs: 60_000,
    limit: 10,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * 10 an hour per user for `POST /auth/sessions/revoke-others`, behind
   * `requireAuth`: a person signs out their other devices a few times at most,
   * and each call locks the user row and writes a denial per session.
   */
  revokeOtherSessions: {
    name: 'revoke-other-sessions',
    windowMs: 60 * 60 * 1000,
    limit: 10,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * 10 per 15 minutes per IP for `POST /auth/link/request`. Per IP only: a
   * per-address limit would let anyone deny the owner their link. One inbox
   * is bounded by the mail cooldown (`SIGN_IN_LINK_MAIL_COOLDOWN`) and the
   * daily ceiling (`SIGN_IN_LINK_RECIPIENT_DAILY_LIMIT`), which the
   * follow-up checks after the reply.
   */
  signInLinkRequest: {
    name: 'sign-in-link-request',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * 20 per 15 minutes per IP for `POST /auth/link/verify`. The token is
   * single-use and carries 256 bits, so this bounds a client working through
   * dead links or malformed attempts, not guessing.
   */
  signInLinkVerify: {
    name: 'sign-in-link-verify',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * 20 per 15 minutes per IP, one instance shared by `POST
   * /invitations/verify` and `POST /invitations/confirm`: a confirm spends
   * two (the click that mailed it, then the link's click), a resend three.
   * Keyed on IP alone: public routes, with no caller identity to key on.
   * Every token is single-use and carries 256 bits, so this bounds a client
   * working through dead links, not guessing.
   */
  invitationVerify: {
    name: 'invitation-verify',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * 10 per 15 minutes per signed-in user, one instance shared by
   * `POST /auth/step-up/link/request` and `/step-up/link/verify`: a normal
   * confirm spends two, and the request's own cooldown
   * (`STEP_UP_LINK_COOLDOWN`) bounds the mail. The link carries 256 bits, so
   * this bounds a client working through dead links, not guessing.
   */
  stepUpLink: {
    name: 'step-up-link',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * 20 per 15 minutes per user, one instance shared by every passkey write
   * (create options and verify, rename, delete). A person sets up a few
   * passkeys and tidies a list; 20 covers that, and a script stops at 20.
   */
  passkeyManage: {
    name: 'passkey-manage',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'user',
    unit: 'requests',
  },
  /**
   * 300 per 15 minutes per IP on `POST /auth/passkeys/sign-in/options` only.
   * The call is cheap, holds no secret and runs on every sign-in page load, so
   * a shared office address needs room; the verify call has the tighter budget.
   */
  passkeySignInOptions: {
    name: 'passkey-sign-in-options',
    windowMs: 15 * 60 * 1000,
    limit: 300,
    keyBy: 'ip',
    unit: 'requests',
  },
  /**
   * 20 per 15 minutes per IP on `POST /auth/passkeys/sign-in/verify` only.
   * Each try is one assertion, so this allows 20 tries; a script working
   * through challenges stops there.
   */
  passkeySignIn: {
    name: 'passkey-sign-in',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyBy: 'ip',
    unit: 'attempts',
  },
  /**
   * 10 per 15 minutes per user, one instance shared by
   * `POST /auth/passkeys/step-up/options` and `/step-up/verify`: a normal
   * confirm spends two, so this allows about five tries. The user is
   * signed in, and a wrong assertion costs a spent challenge, so this bounds
   * a script, not a person who mistouches a few times.
   */
  passkeyStepUp: {
    name: 'passkey-step-up',
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyBy: 'user',
    unit: 'attempts',
  },
  /**
   * Per owner, one budget across every billing write (checkout, its confirm,
   * the interval switch, the card change and the cancel). Each can call the
   * payment provider, whose own rate limit is shared by every workspace, so
   * this is tighter than `authenticatedWrite`; 10 a minute covers a person
   * retrying a checkout a few times.
   */
  billingWrite: {
    name: 'billing-write',
    windowMs: 60_000,
    limit: 10,
    keyBy: 'user',
    unit: 'requests',
  },
  /**
   * Per owner, the invoice list, which reads the payment provider on every
   * page. 30 a minute covers paging through years of invoices.
   */
  billingRead: {
    name: 'billing-read',
    windowMs: 60_000,
    limit: 30,
    keyBy: 'user',
    unit: 'requests',
  },
  /**
   * 3000 a minute per IP on the Razorpay webhook, counting only accepted
   * deliveries (status below 400). Razorpay sends from a few addresses, so
   * the budget is per IP and sized for a renewal storm; the route only
   * verifies, records and queues, so a delivery costs little. Unsigned
   * traffic never spends it; `billingWebhookRejected` bounds that.
   */
  billingWebhook: {
    name: 'billing-webhook',
    windowMs: 60_000,
    limit: 3000,
    keyBy: 'ip',
    counts: 'accepted',
    unit: 'attempts',
  },
  /**
   * 30 a minute per IP on the Razorpay webhook, counting only responses of
   * 400 or above: the cap on forged or malformed deliveries from one
   * address. Mounted before `billingWebhook`; a signed delivery never spends it.
   */
  billingWebhookRejected: {
    name: 'billing-webhook-rejected',
    windowMs: 60_000,
    limit: 30,
    keyBy: 'ip',
    counts: 'rejected',
    unit: 'attempts',
  },
}
