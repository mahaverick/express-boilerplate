/**
 * @file The one rule set that removes personal data and secrets from the
 * text of an error before it leaves the process: an exception's type and
 * value, and each stack frame's filename and function. The frontends port
 * it, and all three are tested against one vector file
 * (tests/fixtures/error-scrub-vectors.json), so a rule changes here, in
 * that file and in both ports together.
 */
import { ERROR_VALUE_MAX } from '@/constants/error-tracking.constants'

/**
 * What ends a text cut to `ERROR_VALUE_MAX` characters.
 */
const TRUNCATION_MARKER = '…[truncated]'

/**
 * The most characters the rules scan: four times what is kept, so a text
 * the rules shorten still fills the cap, while a pathological input never
 * costs more than a bounded scan.
 */
const SCAN_MAX = 4 * ERROR_VALUE_MAX

/**
 * Postgres's `Key (col)=(value)` detail. The value runs to the line's last
 * `)` that is followed by the end, whitespace or punctuation, so a value
 * containing parentheses is replaced whole.
 */
const KEY_DETAIL_PATTERN = /Key \(([^()]*)\)=\(.*\)(?=$|[\s.,;:])/gm

/**
 * A URL or path followed by a query string: the part before `?` is kept.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const QUERY_PATTERN = /((?:https?:\/\/|\/)[^\s?"'<>]*)\?[^\s"'<>]+/g

/**
 * `Bearer` and the credential after it, in any letter case.
 */
const BEARER_PATTERN = /\bBearer\s+[^\s"',;]+/gi

/**
 * A JSON Web Token: three dot-separated base64url segments, the first
 * starting `eyJ` (`{"`). The signature may be empty (an unsigned token).
 */
const JWT_PATTERN = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g

/**
 * A PostHog project, personal or secret key.
 */
const POSTHOG_KEY_PATTERN = /\bph[cxs]_\w+/g

/**
 * An email address.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const EMAIL_PATTERN = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * A run of 32 or more hex digits: a hash, a token or a key. It is delimited
 * by hex digits rather than word boundaries, so a run stuck to other word
 * characters (`key_<hex>`, `<hex>suffix`) is still replaced.
 */
const HEX_RUN_PATTERN = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g

/**
 * A run of 40 or more base64 or base64url characters, with its padding.
 */
const BASE64_RUN_PATTERN = /[\w+/-]{40,}={0,2}/g

/**
 * The share of a slash-containing run's letters that must be uppercase for
 * it to read as base64 rather than a file path.
 */
const BASE64_UPPERCASE_SHARE = 0.25

/**
 * Whether a long base64-alphabet run is a secret rather than a file path.
 * A run with no `/` always is. One with a `/` is when it holds a digit and
 * at least a quarter of its letters are uppercase: random base64 is half
 * uppercase, and a path such as `/app/src/services/errors/error-scrubber`
 * is almost all lowercase.
 * @param run - The matched run.
 * @returns True when the run should be replaced.
 */
function isSecretRun(run: string): boolean {
  if (!run.includes('/')) return true
  const letters = run.replaceAll(/[^A-Za-z]/g, '')
  const uppercase = run.replaceAll(/[^A-Z]/g, '')
  return uppercase.length >= letters.length * BASE64_UPPERCASE_SHARE && /\d/.test(run)
}

/**
 * The text the rules scan: at most `SCAN_MAX` characters, and when cut,
 * only up to the last whitespace before the cut, so half a secret is never
 * kept. A cut text with no whitespace is dropped whole.
 * @param value - The raw text.
 * @returns The scanned prefix.
 */
function scanned(value: string): string {
  if (value.length <= SCAN_MAX) return value
  let end = SCAN_MAX
  while (end > 0 && !/\s/.test(value.charAt(end - 1))) end -= 1
  return value.slice(0, end)
}

/**
 * Cut a text to `ERROR_VALUE_MAX` characters, the marker included.
 * @param value - The scrubbed text.
 * @param wasCut - Whether `scanned` already dropped part of the input.
 * @returns The text, ending in `…[truncated]` when anything was dropped.
 */
function capped(value: string, wasCut: boolean): string {
  if (!wasCut && value.length <= ERROR_VALUE_MAX) return value
  const kept = value.slice(0, ERROR_VALUE_MAX - TRUNCATION_MARKER.length)
  return `${kept}${TRUNCATION_MARKER}`
}

/**
 * Remove personal data and secrets from one text, by eight rules applied in
 * this order: Postgres `Key (col)=(value)` details keep the columns and lose
 * the value (`([value])`); a URL's or path's query string becomes
 * `?[query]`; `Bearer <credential>` becomes `Bearer [token]`; a JWT becomes
 * `[jwt]`; a PostHog key (`phc_`, `phx_`, `phs_`) becomes `[posthog-key]`; an
 * email address becomes `[email]`; a run of 32 or more hex digits, and a
 * secret-looking run of 40 or more base64 characters (`isSecretRun`), become
 * `[secret]`; and the result is cut to 1024 characters, ending in
 * `…[truncated]`. Applying it twice gives the same text as applying it once.
 * @param value - The text: an exception's type or value, or a frame's filename or function.
 * @returns The scrubbed text.
 */
export function scrubText(value: string): string {
  const input = scanned(value)
  const scrubbed = input
    .replaceAll(KEY_DETAIL_PATTERN, 'Key ($1)=([value])')
    .replaceAll(QUERY_PATTERN, '$1?[query]')
    .replaceAll(BEARER_PATTERN, 'Bearer [token]')
    .replaceAll(JWT_PATTERN, '[jwt]')
    .replaceAll(POSTHOG_KEY_PATTERN, '[posthog-key]')
    .replaceAll(EMAIL_PATTERN, '[email]')
    .replaceAll(HEX_RUN_PATTERN, '[secret]')
    .replaceAll(BASE64_RUN_PATTERN, (run) => (isSecretRun(run) ? '[secret]' : run))
  return capped(scrubbed, input.length < value.length)
}
