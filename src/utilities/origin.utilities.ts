/**
 * @file `isAllowedOrigin`, the one definition of an origin this API will talk
 * to, used by the CORS configuration and the Origin check on the refresh
 * cookie's routes (origin.middleware.ts).
 */
import { getEnv } from '@/configs/env.config'

/**
 * Whether a request's origin may be granted CORS access: no `Origin` at all
 * (a non-browser client, or a same-origin GET), `WEB_URL`'s origin,
 * `APEX_URL`'s origin, or one listed in `CORS_ALLOWED_ORIGINS`.
 *
 * Exact string equality against a fixed set, never a suffix or regex match,
 * which a lookalike domain can satisfy. For CORS a refused origin only has
 * the grant header withheld; `requireAllowedOriginWhenPresent` refuses it
 * outright on `/auth/refresh` and `/auth/logout`.
 * @param origin - The request's `Origin` header, or undefined when it has none.
 * @returns True when the request may proceed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true

  const env = getEnv()

  if (canonicalOrigin(env.WEB_URL) === origin || canonicalOrigin(env.APEX_URL) === origin) {
    return true
  }

  return parseOriginList(env.CORS_ALLOWED_ORIGINS).has(origin)
}

/**
 * Reduce a configured URL down to the bare origin a browser's `Origin`
 * header actually sends: scheme + host + port, lowercased, no trailing
 * slash, no path. A configured `https://App.Example.com/path` would
 * otherwise never equal a browser's `Origin`. Only the allow-list is
 * canonicalized, never the incoming header, so attacker input is compared
 * exactly as sent.
 * @param value - A configured origin/URL, or undefined.
 * @returns The canonical origin, or undefined when `value` is missing or not a parseable URL.
 */
function canonicalOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    // A malformed entry is skipped, not a crash on every request with an Origin.
    return undefined
  }
}

/**
 * Split a comma-separated origin list, trimming blanks and canonicalizing
 * each entry (see `canonicalOrigin`).
 * @param raw - The raw env value, or undefined.
 * @returns The set of origins it names.
 */
function parseOriginList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => canonicalOrigin(entry))
    .filter((entry): entry is string => entry !== undefined)
  return new Set(origins)
}
