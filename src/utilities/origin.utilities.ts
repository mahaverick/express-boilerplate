import { getEnv } from '@/configs/env.config'

/**
 * The one definition of "an origin this API will talk to".
 *
 * Exact string equality against a fixed set — never a suffix or regex match.
 * `https://app.example.com.evil.test` ENDS WITH nothing useful, but a
 * carelessly written `endsWith('.example.com')` would accept
 * `https://evil-example.com` and a sloppy regex would accept worse.
 * @param origin - The request's `Origin` header, or undefined when it has none.
 * @returns True when the request may proceed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // No Origin header at all. That is what a same-origin request sends, and
  // also what a non-browser client (curl, a mobile app, a server-to-server
  // call) sends. CORS is a browser mechanism; there is nothing to enforce.
  if (!origin) return true

  const env = getEnv()

  // WEB_URL is always allowed and never needs listing. The load-bearing case
  // is a PRODUCTION cross-origin deployment — `app.example.com` calling
  // `api.example.com` — not the local dev proxy: under Vite, the page and
  // the request are both `localhost:5173`, so the browser treats it as
  // same-origin and applies no CORS check at all regardless of what this
  // function returns (`callback(null, false)` only withholds the grant
  // header; it does not reject the request server-side). Vite's proxy does
  // measurably forward the browser's `Origin` header on POST (GET arrives
  // with none), but that fact is irrelevant to dev login working — it works
  // either way, because there is no cross-origin boundary for CORS to police
  // there in the first place.
  if (canonicalOrigin(env.WEB_URL) === origin) return true

  return parseOriginList(env.CORS_ALLOWED_ORIGINS).has(origin)
}

/**
 * Reduce a configured URL down to the bare origin a browser's `Origin`
 * header actually sends: scheme + host + port, lowercased, no trailing
 * slash, no path. `WEB_URL` is validated as "an http(s) URL" (env.config.ts)
 * but that accepts `https://app.example.com/`, `HTTPS://App.Example.com`, or
 * `.../some/path` — none of which will ever equal-match the `Origin` header
 * a real browser sends, so an uncanonicalized comparison here would silently
 * reject the primary frontend in production. Canonicalizing what the
 * allowlist HOLDS, never the incoming `Origin` header, keeps the comparison
 * an exact match — no normalisation is ever applied to attacker-controlled
 * input.
 * @param value - A configured origin/URL, or undefined.
 * @returns The canonical origin, or undefined when `value` is missing or not a parseable URL.
 */
function canonicalOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    // A malformed allowlist entry must be skipped, not crash every request
    // that carries an Origin header — see parseOriginList below.
    return undefined
  }
}

/**
 * Split a comma-separated origin list, trimming blanks and canonicalizing
 * each entry (see `canonicalOrigin`) so a trailing slash or mixed case in
 * `CORS_ALLOWED_ORIGINS` doesn't silently defeat the match the same way an
 * unnormalised `WEB_URL` would.
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
