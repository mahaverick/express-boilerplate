// src/middlewares/rate-limit.middleware.ts
//
// Two limiters: `createLoginRateLimiter` and `createRefreshRateLimiter`. Both
// are FACTORIES, never a top-level `const` built at module-import time —
// `rateLimit(...)` allocates a `Store` instance, and express-rate-limit
// refuses to let two limiter instances share one (`ERR_ERL_STORE_REUSE`), so
// a factory is also what lets a test build a fresh instance with a small
// `limit`/`windowMs` instead of waiting out the real production window. This
// mirrors auth.routes.ts's own convention (see its header comment on
// unicorn/no-top-level-side-effects): build inside a function, call the
// function where the router is assembled.
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

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5

// Generous on purpose — see this file's header comment on why the refresh
// limiter is not a security boundary. High enough that no realistic client
// (including this repo's own integration suite, which reuses one IP across
// many test files) trips it during ordinary use.
const REFRESH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const REFRESH_RATE_LIMIT_MAX_ATTEMPTS = 300

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
