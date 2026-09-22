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

  // WEB_URL is always allowed and never needs listing. This is not a
  // convenience: Vite's dev proxy FORWARDS the browser's Origin header on
  // POST (measured — GET arrives with none), so an allowlist that defaulted
  // to empty would fail every login in development while GETs kept working.
  if (origin === env.WEB_URL) return true

  return parseOriginList(env.CORS_ALLOWED_ORIGINS).has(origin)
}

/**
 * Split a comma-separated origin list, trimming blanks.
 * @param raw - The raw env value, or undefined.
 * @returns The set of origins it names.
 */
function parseOriginList(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
}
