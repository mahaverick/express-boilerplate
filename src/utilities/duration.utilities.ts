// src/utilities/duration.utilities.ts
//
// The one module that imports `ms`, for the same reason password.utilities.ts
// is the one module that imports bcrypt: everything that needs to turn a
// human-written duration string ("15m", "30d") into milliseconds goes
// through parseDurationMs, so the one type-level wrinkle below is paid for
// exactly once rather than at every call site.
//
// `ms`'s own published type is a function overload keyed off its own
// `StringValue` literal union (`` `${number}` `` optionally suffixed with a
// unit, e.g. "15m"). That type cannot describe an arbitrary,
// dynamically-supplied `string` — which is exactly what a value read out of
// `EnvSchema` or passed in at runtime always is — so calling `ms(value)`
// with a plain `string` fails to type-check under any of its declared
// overloads. The cast below narrows the imported binding to the signature
// `ms` actually implements at runtime once, here, with the real safety
// enforced by checking the RETURN value (a finite, positive number or
// nothing) rather than trusting the argument's compile-time type. This is
// the same "third-party type is narrower than its real contract" shape
// base.repository.ts documents for Drizzle's query builder, resolved the
// same way: isolate the workaround in one place instead of asserting at
// every caller.
import ms from 'ms'

const parse: (value: string) => number | undefined = ms as unknown as (
  value: string
) => number | undefined

/**
 * The one place this constant is defined. Both `token.utilities.ts` (to
 * convert `expiresIn` to whole seconds for `jsonwebtoken`) and
 * `session-denylist.service.ts` (to convert a Redis `EX` TTL to whole
 * seconds) needed it, and it lives here — rather than in either of
 * them — for the same reason `requireDurationMs` does: routing it through
 * `token.utilities.ts` would close an import cycle
 * (`user-token.repository` -> `session-denylist.service` ->
 * `token.utilities` -> `user-token.repository`), and this module has no
 * such dependency, so it stays a leaf.
 */
export const MS_PER_SECOND = 1000

/**
 * Parse a duration string (e.g. "15m", "30d", "3600000") into milliseconds.
 *
 * Never throws. `ms()` itself throws only for a non-string or an empty
 * string (its own "not a non-empty string or a valid number" guard) — this
 * function catches that case, and additionally rejects anything `ms()`
 * could not parse (it returns `undefined` for a non-empty string it does
 * not recognise, rather than throwing) and anything that parses to zero or
 * a negative number, which is never a meaningful token lifetime. Every
 * caller therefore has exactly one failure value to check instead of also
 * having to guard against a thrown error.
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
 * Lives here, not in token.utilities.ts (which originally defined it),
 * because `session-denylist.service.ts` needs it too, and
 * `user-token.repository.ts` (Task 3) imports `denySession` from that
 * service — routing through token.utilities.ts, which itself imports
 * `UserTokenRepository`, would close an import cycle:
 * user-token.repository -> session-denylist.service -> token.utilities ->
 * user-token.repository. This module has no such dependency, so it stays a
 * leaf.
 * @param value - An `ACCESS_TOKEN_TTL`/`REFRESH_TOKEN_TTL`-shaped value already known to be `ms()`-parseable.
 * @returns The duration in milliseconds.
 * @throws {Error} Only if that boot-time invariant was somehow violated.
 */
export function requireDurationMs(value: string): number {
  const parsed = parseDurationMs(value)
  if (parsed === undefined) {
    // Unreachable in practice: getEnv() already rejects an unparseable TTL
    // at boot (env.config.ts). Guards the invariant explicitly rather than
    // asserting it away, so a future change that weakens that refinement
    // fails loudly here instead of silently signing a token with NaN.
    throw new Error(`Invalid duration string: "${value}"`)
  }
  return parsed
}
