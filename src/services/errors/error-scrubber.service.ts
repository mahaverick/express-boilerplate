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
 * containing parentheses is replaced whole; a detail with no such `)` (cut
 * short) is replaced to the end of the line. Neither runs past the next
 * `Key (`, so each detail in a text is handled on its own.
 */
const KEY_DETAIL_PATTERN =
  /Key \(([^()]*)\)=\((?:(?:(?!Key \().)*\)(?=$|[\s.,;:])|(?:(?!Key \().)*)/gm

/**
 * A value Postgres echoes back from the input: `invalid input syntax for
 * type X: "value"`, `invalid input value for enum X: "value"`, `malformed
 * array literal: "value"` and `date/time field value out of range:
 * "value"`. A doubled
 * quote inside the value does not end it.
 */
const PG_INPUT_PATTERN =
  /(invalid input (?:syntax for type|value for enum) [\w." ]+?: |malformed \w+ literal: |date\/time field value out of range: )"(?:[^"]|"")*"/g

/**
 * A number Postgres echoes back in `value "<n>" is out of range for type
 * X`: the quoted value is replaced and the rest kept.
 */
const PG_RANGE_PATTERN = /\b(value )"(?:[^"]|"")*"(?= is out of range for type)/g

/**
 * The snippet V8 echoes in a JSON parse error: `"<text>"... is not valid JSON`.
 * It matches at the start of a line or after whitespace or `(`.
 */
const JSON_SNIPPET_PATTERN = /(^|[\s(])(?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/gm

/**
 * The credentials in a URL's userinfo: `scheme://user:pass@host`. The
 * scheme and `://` are kept. The userinfo runs to the last `@` before a
 * `/`, `?`, `#` or whitespace, `@` inside it included. A quote ends the
 * userinfo when a delimiter (`,` `:` `;` `}` `]` or whitespace) follows it, so
 * it never spans from one JSON field into the next.
 */
const USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#<>"']|["'](?![,:;}\]\s]))+@/gi

/**
 * A URL or path followed by a query string: the part before `?` is kept.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const QUERY_PATTERN = /((?:https?:\/\/|\/)[^\s?"'<>]*)\?[^\s"'<>]+/g

/**
 * A URL's or path's fragment: the part before `#` is kept.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const FRAGMENT_PATTERN = /((?:https?:\/\/|\/)[^\s#"'<>]*)#[^\s"'<>]+/g

/**
 * `Bearer` and the credential after it, in any letter case.
 */
const BEARER_PATTERN = /\bBearer\s+[^\s"',;]+/gi

/**
 * HTTP Basic credentials: `Basic` in the case `Basic`, `basic` or `BASIC`, and a base64 value of
 * at least eight characters that holds an uppercase letter, a digit, `+` or
 * `/`, so prose such as `Basic validation failed` is left alone.
 */
const BASIC_PATTERN =
  /\b([Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]*[A-Z0-9+/])(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2,3}={0,2})?(?![\w+/=])/g

/**
 * A secret-named key and its value: `password=...`, `"token":"..."`,
 * `api_key: ...`, `Cookie: ...`, `password%3D...`. The key and its separator
 * are kept. The value is a quoted string (spaces and escaped quotes
 * included, also inside a JSON string) or a run up to a delimiter. A value
 * already replaced by this scrubber (`[redacted]`, `[token]`...) and the
 * bare words `undefined`, `null`, `missing`, `true` and `false` are left as
 * they are, so `token: undefined` stays readable. After `authorization` or
 * `auth` the value may begin with a known scheme word (`Token abc` becomes `Token
 * [redacted]`; `Bearer`, `Basic`, `Token`, `ApiKey`, `Digest`, `Negotiate`,
 * `NTLM`, `Hawk`, `HOBA`, `DPoP`, `OAuth`, `AWS4-HMAC-SHA256`, `SCRAM-SHA-n`), so the credential and not the scheme is replaced; `signature`
 * covers the part of an AWS header after the credential.
 */
const KV_SECRET_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity, sonarjs/super-linear-regex -- one pattern per rule keeps the rule list the spec; scrubText scans at most SCAN_MAX characters
  /\b([\w-]*?(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|session|sid|cookie|credentials?|signature|authorization|auth|jwt|otp)\\?["']?\s*(?:[:=]|%3D)\s*\\?["']?(?:(?<=(?:authorization|auth)\\?["']?\s*(?:[:=]|%3D)\s*\\?["']?)(?:Bearer|Basic|Token|ApiKey|Digest|Negotiate|NTLM|Hawk|HOBA|DPoP|OAuth|AWS4-HMAC-SHA256|SCRAM-SHA-\d+)[ \t]+)?)(?!(?:(?:Bearer|Basic) )?\[(?:redacted|value|credentials|query|fragment|token|jwt|posthog-key|email|secret)\])(?!(?<=(?:authorization|auth)\\?["']?\s*(?:[:=]|%3D)\s*\\?["']?)(?:Bearer|Basic|Token|ApiKey|Digest|Negotiate|NTLM|Hawk|HOBA|DPoP|OAuth|AWS4-HMAC-SHA256|SCRAM-SHA-\d+)[ \t]+\[(?:redacted|value|credentials|query|fragment|token|jwt|posthog-key|email|secret)\])(?!(?<![\\"'])(?:undefined|null|missing|true|false)(?=[\s,;&})\]]|$))(?!(?<=["'])(?:undefined|null|missing|true|false)(?=\\?["']))(?:(?<=\\")(?:(?!\\")[^\n])+|(?<=["'])(?:[^"'\\\n]|\\.)+|[^\s"'\\,;&})\]]+)/gi

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
 * An email address, in any script, with `@` written plainly or as `%40`.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const EMAIL_PATTERN = /[\p{L}\p{N}_.%+-]+(?:@|%40)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu

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
 * Remove personal data and secrets from one text, by these rules applied in
 * this order: Postgres `Key (col)=(value)` details keep the columns and lose
 * the value (`([value])`); a value Postgres echoes after `invalid input
 * syntax for type`, `invalid input value for enum`, `malformed ... literal:`
 * or `date/time field value out of range:`, the number in `value "n" is out of
 * range for type`, and the snippet in a V8 `is not valid JSON` error, become `"[value]"`; the userinfo of a URL
 * becomes `[credentials]@`; a URL's or path's query string becomes
 * `?[query]` and its fragment `#[fragment]`; `Bearer <credential>` becomes
 * `Bearer [token]`; `Basic <base64>` becomes `Basic [token]`, the scheme's case kept; the value of a
 * secret-named key (`password`, `token`, `secret`, `api_key`, `access_key`,
 * `private_key`, `session`, `sid`, `cookie`, `credentials`, `authorization`, `auth`,
 * `jwt`, `otp`, `signature`) becomes `[redacted]`; a JWT becomes `[jwt]`; a
 * PostHog key (`phc_`, `phx_`, `phs_`) becomes `[posthog-key]`; an email
 * address, written with `@` or `%40`, becomes `[email]`; a run of 32 or more
 * hex digits, and a secret-looking run of 40 or more base64 characters
 * (`isSecretRun`), become `[secret]`; and the result is cut to 1024
 * characters, ending in `…[truncated]`. A key-named word is replaced even in
 * prose (`Missing token: please log in` becomes `Missing token: [redacted] log in`): the
 * rule trades some readable text for never leaking a value. Applying it
 * twice gives the same text as applying it once.
 * @param value - The text: an exception's type or value, or a frame's filename or function.
 * @returns The scrubbed text.
 */
export function scrubText(value: string): string {
  const input = scanned(value)
  const scrubbed = input
    .replaceAll(KEY_DETAIL_PATTERN, 'Key ($1)=([value])')
    .replaceAll(PG_INPUT_PATTERN, '$1"[value]"')
    .replaceAll(PG_RANGE_PATTERN, '$1"[value]"')
    .replaceAll(JSON_SNIPPET_PATTERN, '$1"[value]" is not valid JSON')
    .replaceAll(USERINFO_PATTERN, '$1[credentials]@')
    .replaceAll(QUERY_PATTERN, '$1?[query]')
    .replaceAll(FRAGMENT_PATTERN, '$1#[fragment]')
    .replaceAll(BEARER_PATTERN, 'Bearer [token]')
    .replaceAll(BASIC_PATTERN, '$1 [token]')
    .replaceAll(KV_SECRET_PATTERN, '$1[redacted]')
    .replaceAll(JWT_PATTERN, '[jwt]')
    .replaceAll(POSTHOG_KEY_PATTERN, '[posthog-key]')
    .replaceAll(EMAIL_PATTERN, '[email]')
    .replaceAll(HEX_RUN_PATTERN, '[secret]')
    .replaceAll(BASE64_RUN_PATTERN, (run) => (isSecretRun(run) ? '[secret]' : run))
  return capped(scrubbed, input.length < value.length)
}
