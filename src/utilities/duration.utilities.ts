/**
 * @file The one module that imports `ms`: every human-written duration ("15m",
 * "30d") becomes milliseconds through `parseDurationMs`.
 */
import ms from 'ms'

/**
 * `ms` narrowed to what it does at runtime. Its published overloads accept
 * only its `StringValue` literal union, never a runtime `string`, so the
 * cast lives here once and `parseDurationMs` checks the return value instead.
 */
const parse: (value: string) => number | undefined = ms as unknown as (
  value: string
) => number | undefined

/**
 * Milliseconds per second, for session.service.ts (`expiresIn` in seconds)
 * and session-denylist.service.ts (a Redis `EX` TTL). Here, not in
 * session.service.ts: that module imports session-denylist.service.ts, so
 * the reverse import would close a cycle.
 */
export const MS_PER_SECOND = 1000

/**
 * Parse a duration string (e.g. "15m", "30d", "3600000") into milliseconds.
 *
 * Never throws: `ms()`'s throw for an empty string is caught, and a value it
 * cannot parse or that is not a finite positive number is `undefined`, so a
 * caller has one failure value to check.
 * @param value - The duration string to parse.
 * @returns The parsed duration in milliseconds, or undefined when `value` is not a valid, positive duration.
 */
export function parseDurationMs(value: string): number | undefined {
  try {
    const result = parse(value)
    return typeof result === 'number' && Number.isFinite(result) && result > 0 ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a validated TTL string to milliseconds, trusting the invariant
 * `env.config.ts`'s refinement already enforced at boot.
 *
 * Here, not in session.service.ts, for the same import-cycle reason as
 * `MS_PER_SECOND`.
 * @param value - An `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL`-shaped value already known to be `ms()`-parseable.
 * @returns The duration in milliseconds.
 * @throws {Error} Only if that boot-time invariant was somehow violated.
 */
export function requireDurationMs(value: string): number {
  const parsed = parseDurationMs(value)
  if (parsed === undefined) {
    // getEnv() rejects this at boot; throwing beats signing a token with NaN.
    throw new Error(`Invalid duration string: "${value}"`)
  }
  return parsed
}
