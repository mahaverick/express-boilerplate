/**
 * @file `createRateLimiter` builds every rate limiter this API mounts, from the
 * specs in rate-limit.constants.ts's `RATE_LIMITS`, which hold each endpoint's
 * threat model.
 */
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
 * error envelope's `code` field, so a client can branch on it without
 * matching on `message`.
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
 * `undefined` for `'ip'`, which keeps express-rate-limit's default
 * IPv6-normalising key generator.
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
 * A marker `createRateLimiter` sets on every middleware it returns, holding
 * the spec's name. route-limiters.test.ts reads it off a route's handler
 * chain to prove a limiter is present.
 */
export const RATE_LIMITER_MARK = Symbol('rateLimiter')

/**
 * Build a rate limiter from a `RATE_LIMITS` entry.
 *
 * A factory, called where a router is assembled: express-rate-limit refuses
 * to let two limiters share a store (`ERR_ERL_STORE_REUSE`). Each store is
 * keyed `<REDIS_KEY_PREFIX>:rl:<name>:`, so two specs must never share a
 * name (rate-limit.constants.test.ts pins this), or one endpoint's traffic
 * spends another's budget. The one deliberate exception: `authenticatedWrite`
 * is built once per router (tenant, notification, profile), so on Redis they
 * spend one per-user budget, and on the in-memory fallback each router's
 * instance counts on its own.
 * @param spec - The limiter's configuration — see `RateLimiterSpec`.
 * @param overrides - `windowMs`/`limit` to override, e.g. a small window for a test. Every other field is fixed by `spec`.
 * @returns Express middleware enforcing the limit, tagged with `RATE_LIMITER_MARK` set to `spec.name`.
 */
export function createRateLimiter(
  spec: RateLimiterSpec,
  overrides: Partial<Pick<RateLimiterSpec, 'windowMs' | 'limit'>> = {}
): RequestHandler {
  const keyGenerator = keyGeneratorFor(spec.keyBy)

  const handler = rateLimit({
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
  Object.assign(handler, { [RATE_LIMITER_MARK]: spec.name })
  return handler
}
