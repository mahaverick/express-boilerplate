// src/middlewares/rate-limit.middleware.ts
//
// One generic limiter, `createRateLimiter(spec)`, builds every rate
// limiter this API mounts. The specs (window, limit, key axis) live in
// `constants/rate-limit.constants.ts`'s `RATE_LIMITS` table, which is the
// single source of truth for the per-endpoint threat model — see each
// entry's own comment there (composite login key, tight-IP/generous-email
// resend-verification and forgot-password pairs, user-keyed tenant/
// change-password limiters, etc.). See that file's own header comment for
// why the key-derivation functions live there too (import-x/no-cycle).
//
// A factory, not a module-scope constant: `rateLimit(...)` allocates a
// `Store` instance, and express-rate-limit refuses to let two limiter
// instances share one (`ERR_ERL_STORE_REUSE`) — build where a router is
// assembled, matching this codebase's existing convention for
// parameterised middleware (auth.routes.ts's own header comment on
// unicorn/no-top-level-side-effects).
//
// ONE STORE PREFIX PER ENDPOINT: each call builds its own store with
// `limiterStore(spec.name)`, keyed `<REDIS_KEY_PREFIX>:rl:<name>:`. Two
// limiters must never share a `name` — a shared bucket lets traffic on one
// endpoint spend another's budget. `RATE_LIMITS`'s own test
// (tests/unit/constants/rate-limit.constants.test.ts) pins uniqueness.
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { SharedRateLimitStore } from '@/configs/rate-limit-store.config'
import {
  authenticatedUserRateLimitKey,
  submittedEmailRateLimitKey,
  type RateLimiterSpec,
} from '@/constants/rate-limit.constants'
import { HttpError } from '@/errors/http-error'
import { redisKey } from '@/services/redis.service'

/**
 * Machine-readable code identifying a rate-limited request, carried in the
 * error envelope's `code` field (`src/errors/http-error.ts`'s `HttpError`)
 * — the same pattern `ACCESS_TOKEN_EXPIRED` uses, so a client can branch on
 * this without matching on `message`.
 */
export const RATE_LIMITED_CODE = 'RATE_LIMITED'

/**
 * Build one limiter's store under its own `rl:<name>` keyspace.
 * @param name - The limiter's endpoint name, unique within `RATE_LIMITS`.
 * @returns A store whose Redis keys start with `<REDIS_KEY_PREFIX>:rl:<name>:`.
 */
function limiterStore(name: string): SharedRateLimitStore {
  return new SharedRateLimitStore(`${redisKey('rl', name)}:`)
}

/**
 * Resolve `spec.keyBy` to the `keyGenerator` express-rate-limit needs, or
 * `undefined` for `'ip'` — which leaves express-rate-limit's own default
 * (IPv6-normalising) key generator in place, the same one every IP-keyed
 * `RATE_LIMITS` entry uses by omitting a custom key generator.
 * @param keyBy - The spec's key axis.
 * @returns A key generator, or undefined to use express-rate-limit's default.
 */
function keyGeneratorFor(
  keyBy: RateLimiterSpec['keyBy']
): ((request: Request) => string) | undefined {
  if (typeof keyBy === 'function') return keyBy
  if (keyBy === 'email') return submittedEmailRateLimitKey
  if (keyBy === 'user') return authenticatedUserRateLimitKey
  return undefined
}

/**
 * Build a rate limiter from a `RATE_LIMITS` entry.
 * @param spec - The limiter's configuration — see `RateLimiterSpec`.
 * @param overrides - `windowMs`/`limit` to override, e.g. a small window for a test. Every other field is fixed by `spec`.
 * @returns Express middleware enforcing the limit.
 */
export function createRateLimiter(
  spec: RateLimiterSpec,
  overrides: Partial<Pick<RateLimiterSpec, 'windowMs' | 'limit'>> = {}
): RequestHandler {
  const keyGenerator = keyGeneratorFor(spec.keyBy)

  return rateLimit({
    windowMs: overrides.windowMs ?? spec.windowMs,
    limit: overrides.limit ?? spec.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: limiterStore(spec.name),
    ...(keyGenerator && { keyGenerator }),
    handler: (_request: Request, _response: Response, next: NextFunction) => {
      next(new HttpError(spec.message, 429, RATE_LIMITED_CODE))
    },
  })
}
