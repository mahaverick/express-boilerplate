// src/middlewares/rate-limit.middleware.ts
//
// Five limiters: `createRegisterRateLimiter`, `createLoginRateLimiter`,
// `createRefreshRateLimiter`, `createLogoutRateLimiter` and
// `createVerifyEmailRateLimiter`. All are
// FACTORIES, never a top-level `const` built at module-import time —
// `rateLimit(...)` allocates a `Store` instance, and express-rate-limit
// refuses to let two limiter instances share one (`ERR_ERL_STORE_REUSE`), so
// a factory is also what lets a test build a fresh instance with a small
// `limit`/`windowMs` instead of waiting out the real production window. This
// mirrors auth.routes.ts's own convention (see its header comment on
// unicorn/no-top-level-side-effects): build inside a function, call the
// function where the router is assembled.
//
// ONE STORE PREFIX PER ENDPOINT — the convention every limiter added here
// must follow. Each factory below constructs its own
// `SharedRateLimitStore('rl:<endpoint>:')`; no two limiters ever share a
// prefix. Three separate reasons, none of which a shared bucket satisfies:
//
//   1. A shared bucket lets traffic on one endpoint spend another's budget.
//      Registration and login would then throttle each other: a burst of
//      signups would start answering 429 to people trying to log in, and an
//      attacker could deliberately exhaust the shared counter on whichever
//      endpoint is cheapest to call in order to deny the one that matters.
//   2. The windows and limits genuinely differ per endpoint (see each
//      constant below), because the thing being bounded differs — bcrypt
//      CPU, database writes, outbound email. One counter cannot express
//      four budgets.
//   3. A 429 must only ever be a statement about the endpoint that returned
//      it. Sharing a bucket makes "I am rate limited on /login" also report
//      that someone else has been hammering /register from the same key — a
//      side channel that exists for no reason.
//
// B3's `/forgot-password` and `/resend-verification` need their own
// `rl:forgot-password:` and `rl:resend-verification:` prefixes on exactly
// this pattern. Both are simultaneously enumeration oracles AND outbound
// email amplifiers, which makes them the one case where a single key is not
// enough: an IP-keyed limiter alone lets a distributed attacker mail-bomb
// one victim address, and an email-keyed limiter alone lets anyone who knows
// an address deny that user their own password reset. Layer TWO limiters
// (each with its own prefix) — one keyed on IP, one keyed on the submitted
// email with a deliberately generous per-address budget — rather than a
// composite of the two, which bounds neither threat on its own.
//
// REGISTER is keyed on the client's IP ALONE — deliberately not the
// composite login uses. Both threats it bounds come from one caller varying
// the email:
//
//   - Enumeration. A duplicate address answers 409 and a fresh one 201, so
//     one request per address reads out the user base. An attacker probing
//     addresses changes the email on every request BY CONSTRUCTION, so any
//     key containing the email hands them a fresh counter each time and
//     bounds nothing at all.
//   - bcrypt CPU exhaustion. `register` (auth.controller.ts) hashes at
//     BCRYPT_COST — roughly 250ms — before anything else, and node-bcrypt
//     runs on libuv's threadpool: 4 threads by default, shared with fs and
//     DNS. A few dozen concurrent registrations starve the whole process,
//     not just this route.
//
// The cost of keying on IP alone is that everyone behind one NAT'd egress
// address shares a counter, so the LIMIT — not the key — is what has to
// keep an office of real people from locking each other out. Hence a rate
// set far above any realistic human signup rate (see the constant below)
// rather than the tight 5-per-15-minutes login uses. Two things make that
// trade acceptable here where it would not be for login: a 429 on
// registration delays a NEW signup and can never lock anyone out of an
// EXISTING account, and it clears itself within the window with nobody
// having to intervene.
//
// What this limiter does NOT do is CLOSE the registration enumeration
// oracle — it BOUNDS it. Closing it means never telling an unauthenticated
// caller whether an address is taken: answer every registration identically
// and mail the address either "finish signing up" or "you already have an
// account". That needs email delivery, which is plan B3's. Until then this
// rate is the whole control, and it is the one number a downstream project
// with a real enumeration concern should tighten.
//
// LOGOUT is keyed on IP alone and is volume protection only, on the same
// reasoning as REFRESH below: it is unauthenticated (deliberately — see
// `logout`'s own header comment), so a caller can drive one indexed lookup
// by token hash plus at most one bounded UPDATE per request without holding
// any credential. It leaks nothing — every logout answers 200 regardless of
// whether the presented token was live, forged, or absent — so there is no
// oracle to close, only load to bound. Its limit is generous for a reason
// specific to this endpoint: a 429 here would leave the refresh cookie
// UNCLEARED (the limiter answers before the handler runs), so the limiter
// must never plausibly be the reason a real user cannot end their session.
//
// LOGIN is keyed on the client's IP *and* the email it submitted —
// deliberately a composite, never either alone:
//
//   - Email alone would let anyone who merely knows a victim's address lock
//     that victim out of their own account: submit N wrong passwords for
//     someone else's email, and the real owner starts seeing 429s too — a
//     denial-of-service handed out for free to anyone who can guess or find
//     an address, needing no credentials of their own.
//   - IP alone would let a distributed attacker (many source IPs) bypass the
//     limit entirely against one target account, since every IP would carry
//     its own independent counter.
//
// The composite also matters for what a 429 is allowed to MEAN. This store
// increments on every attempt, successful or not, and the key never touches
// whether the submitted email belongs to a real account — the limiter
// imports no repository and never queries one. So the number of attempts
// before a 429 is identical whether `victim@example.com` is registered or
// entirely made up; a caller probing many addresses from one IP learns
// nothing about which ones exist by watching for the point at which 429s
// start, because that point never depends on registration status. Undoing
// that would reopen exactly the user-enumeration channel auth.controller.ts
// closes for the login response itself (see that file's header comment).
//
// The gap this leaves OPEN, deliberately: a large botnet spread across many
// IPs can still accumulate many attempts against ONE victim email, because
// each (ip, email) pair is independent. Closing that needs a SECOND,
// email-only limiter layered on top — which reintroduces the lock-out-by-
// guessing-an-address risk above unless it fails soft (CAPTCHA, backoff
// communicated only to the account's own verified channels, etc.). Out of
// this task's scope.
//
// REFRESH is keyed on IP alone, and is volume/abuse protection, not a
// defence against a stolen token: a raw refresh token is a 256-bit random
// value (token.utilities.ts), so guessing one is computationally infeasible
// regardless of any rate limit, and a burst of replays of an
// ALREADY-rotated token gains an attacker nothing beyond the first attempt —
// rotateRefreshToken's reuse detection revokes the whole session on that
// first replay, so attempt 2 fails identically to attempt 200. What this
// limiter bounds instead is the request/database load one client can throw
// at an endpoint that does two writes per call. Its limit is set generously
// (see the constant below) precisely because it is not a security boundary:
// tightening it would cost real users retrying a flaky connection, for a
// property reuse detection already provides.
import { type NextFunction, type Request, type Response } from 'express'
import {
  ipKeyGenerator,
  rateLimit,
  type Options,
  type RateLimitRequestHandler,
} from 'express-rate-limit'
import { SharedRateLimitStore } from '@/configs/rate-limit-store.config'
import { HttpError } from '@/middlewares/error.middleware'

// Deliberately a RATE, not a tight cap — see this file's header comment on
// why registration is keyed on IP alone and why the limit is therefore what
// protects a NAT'd office. 100 per hour is far above any realistic human
// signup rate through one egress address, and far below what either threat
// needs: it bounds one IP to 100 probed addresses per hour (against
// unbounded today) and to ~25 seconds of bcrypt threadpool time per hour.
// It is also comfortably above what this repo's own integration suite
// spends from one IP per run (~20 registrations); a suite re-run does not
// accumulate against it, because tests/helpers/global-setup.ts clears the
// `rl:` keyspace before each run — see that file.
const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const REGISTER_RATE_LIMIT_MAX_ATTEMPTS = 100

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5

// Generous on purpose — see this file's header comment on why the refresh
// limiter is not a security boundary. High enough that no realistic client
// (including this repo's own integration suite, which reuses one IP across
// many test files) trips it during ordinary use.
const REFRESH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const REFRESH_RATE_LIMIT_MAX_ATTEMPTS = 300

// Same generosity, same reasoning as refresh above, plus the endpoint-
// specific one in this file's header comment: a 429 on logout would leave
// the refresh cookie uncleared, so this bound exists to cap load, never to
// stand between a real user and ending their session.
const LOGOUT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const LOGOUT_RATE_LIMIT_MAX_ATTEMPTS = 300

/**
 * Machine-readable code identifying a rate-limited request, carried in the
 * error envelope's `code` field (error.middleware.ts / `HttpError`) — the
 * same pattern `ACCESS_TOKEN_EXPIRED` uses, so a client can branch on this
 * without matching on `message`.
 */
export const RATE_LIMITED_CODE = 'RATE_LIMITED'

/**
 * The lowercase, trimmed email a request body claims, or an empty string
 * when it carries none. Read directly off the raw body rather than through
 * `loginSchema` — the limiter must key consistently even for a request
 * validation will go on to reject — but normalised the same way
 * `emailSchema` (auth.validators.ts) normalises a *valid* one, so
 * "Foo@Example.com" and "foo@example.com" land in the same bucket.
 * @param request - The incoming request.
 * @returns The normalised email, or an empty string.
 */
function submittedEmail(request: Request): string {
  const body = request.body as Record<string, unknown> | undefined
  const email = body?.email
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/**
 * The composite key the login limiter counts attempts by. See this file's
 * header comment for why IP and email are combined rather than either used
 * alone.
 * @param request - The incoming request.
 * @returns A key combining the client's IP and the submitted email.
 */
function loginRateLimitKey(request: Request): string {
  return `${ipKeyGenerator(request.ip ?? 'unknown')}:${submittedEmail(request)}`
}

/**
 * Forward a rate-limited request to the terminal error handler, so it
 * answers through the one response envelope every other error in this API
 * uses (response.utilities.ts) instead of express-rate-limit's own
 * plain-text default.
 * @param _request - The rate-limited request. Unused: the message is fixed.
 * @param _response - The response. Unused: `next` carries the error onward.
 * @param next - Forwards the rejection to the terminal error handler.
 */
function sendRateLimitedResponse(_request: Request, _response: Response, next: NextFunction): void {
  next(new HttpError('Too many attempts. Please try again later.', 429, RATE_LIMITED_CODE))
}

/**
 * Build a registration rate limiter: `limit` attempts per `windowMs`, keyed
 * on the client's IP alone (express-rate-limit's own default key generator,
 * which normalises IPv6 to a /56 subnet).
 *
 * Keyed on IP rather than on IP-and-email the way login is, and generous
 * rather than tight — see this file's header comment for both, and for what
 * this bounds rather than closes. A factory, not a module-scope constant —
 * see this file's header comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createRegisterRateLimiter(
  overrides: Partial<Options> = {}
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
    limit: REGISTER_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:register:'),
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}

/**
 * Build a login rate limiter: `limit` attempts per `windowMs`, keyed on IP
 * and submitted email, reporting only the standardized `RateLimit-*`
 * headers. A factory, not a module-scope constant — see this file's header
 * comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createLoginRateLimiter(overrides: Partial<Options> = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:login:'),
    keyGenerator: loginRateLimitKey,
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}

/**
 * Build a refresh rate limiter: `limit` requests per `windowMs`, keyed on IP
 * alone. See this file's header comment for why this is volume/abuse
 * protection rather than a security boundary. A factory, not a module-scope
 * constant — see this file's header comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createRefreshRateLimiter(
  overrides: Partial<Options> = {}
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: REFRESH_RATE_LIMIT_WINDOW_MS,
    limit: REFRESH_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:refresh:'),
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}

/**
 * Build a logout rate limiter: `limit` requests per `windowMs`, keyed on IP
 * alone. Volume protection for an unauthenticated endpoint that does a
 * database lookup per call, never a security boundary — see this file's
 * header comment, including why its limit is deliberately generous. A
 * factory, not a module-scope constant — see this file's header comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createLogoutRateLimiter(overrides: Partial<Options> = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: LOGOUT_RATE_LIMIT_WINDOW_MS,
    limit: LOGOUT_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:logout:'),
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}

const VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const VERIFY_EMAIL_RATE_LIMIT_MAX_ATTEMPTS = 30

/**
 * Build a verify-email rate limiter: `limit` attempts per `windowMs`, keyed
 * on IP. Keyed on IP alone, not IP-and-token: a token is single-use and
 * high-entropy, so there is no per-token budget worth counting — what this
 * bounds is a client working through many tokens. A factory, not a
 * module-scope constant — see this file's header comment.
 * @param overrides - Options to override, e.g. a small `limit`/`windowMs` for a test.
 * @returns Express middleware enforcing the limit.
 */
export function createVerifyEmailRateLimiter(
  overrides: Partial<Options> = {}
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: VERIFY_EMAIL_RATE_LIMIT_WINDOW_MS,
    limit: VERIFY_EMAIL_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedRateLimitStore('rl:verify-email:'),
    handler: sendRateLimitedResponse,
    ...overrides,
  })
}
