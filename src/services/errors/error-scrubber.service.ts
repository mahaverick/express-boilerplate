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
 * A URL or path followed by a query string: the part before `?` is kept. A
 * bare word before `?` (`callback?code=…`) counts as a path when the query
 * holds an `=`, so a question in prose is left alone. A word after `@` is
 * a domain, which the email rule handles.
 */
const QUERY_PATTERN =
  // eslint-disable-next-line sonarjs/super-linear-regex, sonarjs/regex-complexity -- scrubText scans at most SCAN_MAX characters; one pattern per rule keeps the rule list the spec
  /((?:https?:\/\/|\/)[^\s?"'<>]*|(?<![@\w.-])[\w.-]+(?=\?[^\s"'<>]*=))\?[^\s"'<>]+/g

/**
 * A value this scrubber already wrote, left as it is.
 */
const PLACEHOLDER = String.raw`\[(?:redacted|value|credentials|query|fragment|token|jwt|posthog-key|email|secret|ip|phone)\]`

/**
 * A URL's or path's fragment: the part before `#` is kept, and so is a
 * fragment `isHarmlessFragment` accepts.
 */
// eslint-disable-next-line sonarjs/super-linear-regex -- scrubText scans at most SCAN_MAX characters
const FRAGMENT_PATTERN = /((?:https?:\/\/|\/)[^\s#"'<>]*)#([^\s"'<>]+)/g

/**
 * A source line anchor: `L5`, `L10-L12`, `L10C3-L12C8`.
 */
const LINE_ANCHOR_PATTERN = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/

/**
 * A heading slug: lowercase words of letters only, joined by `-`, with no
 * digit anywhere.
 */
const HEADING_ANCHOR_PATTERN = /^[a-z]+(?:-[a-z]+)*$/

/**
 * A whole word, between `-` or the ends of the slug, that marks a fragment
 * as carrying a credential: `token`, `otp`, `pin`, `code`, `key`, `secret`,
 * `state`, `session`, `auth`, `password`, `nonce`, `sig`, `signature`,
 * `credential`, `jwt` or `bearer`, with plural and long forms. Whole words
 * only, so `authentication`, `design` and `keyboard-shortcuts` are kept.
 */
const KEY_LIKE_WORD_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- one list of credential words
  /(?:^|-)(?:tokens?|otps?|pins?|codes?|keys?|secrets?|states?|sessions?|auth|pass(?:word|code|phrase)?s?|nonces?|sigs?|signatures?|credentials?|jwt|bearer)(?=-|$)/

/**
 * The longest fragment `isHarmlessFragment` keeps as a heading slug.
 */
const HEADING_ANCHOR_MAX = 64

/**
 * A fragment that is one placeholder and nothing else (`#[secret]`).
 */
const PLACEHOLDER_FRAGMENT_PATTERN = new RegExp(`^${PLACEHOLDER}$`)

/**
 * Whether a URL fragment is a real anchor: a source line anchor, a
 * placeholder an earlier scrub wrote (`#[secret]`), or a heading slug
 * (`installation`, `getting-started`) of at most 64 characters that holds no
 * digit, `_` or key-like word (`token-abc`, `api-key`) and that the other
 * rules leave whole. Anything else, an `access_token=` list, a route
 * (`/reset?token=…`), a code with digits or a mixed-case run, is replaced. A
 * slug another rule would rewrite (40 or more characters with a word longer
 * than 20 letters, a run of 32 or more of the letters `a` to `f`, a vendor key
 * prefix such as `xoxb-`) is replaced whole too, so the fragment never comes
 * out as a slug glued to a placeholder that a second scrub would read
 * differently. A random lowercase fragment of letters only and at most 64
 * characters that no other rule touches is indistinguishable from a slug and
 * survives.
 * @param fragment - The text after `#`.
 * @returns True when the fragment is kept.
 */
function isHarmlessFragment(fragment: string): boolean {
  if (LINE_ANCHOR_PATTERN.test(fragment) || PLACEHOLDER_FRAGMENT_PATTERN.test(fragment)) return true
  return (
    fragment.length <= HEADING_ANCHOR_MAX &&
    HEADING_ANCHOR_PATTERN.test(fragment) &&
    !KEY_LIKE_WORD_PATTERN.test(fragment) &&
    scrubText(fragment) === fragment
  )
}

/**
 * The path segment after `/reset/`, `/verify/`, `/invite/` or `/accept/`:
 * a token however short (`/reset/abc123XYZ`). The prefix is kept.
 */
const PATH_TOKEN_PATTERN = /(\/(?:reset|verify|invite|accept)\/)(?!\[)[^\s/?#"'<>]+/g

/**
 * `Bearer` and the credential after it, in any letter case. Besides a word
 * boundary it may follow a digit or a hex letter (the case-insensitive
 * `[G-Z_]` refuses every other letter and `_`), so one glued to a long hex
 * run is replaced before the hex rule takes the run and `Be` with it.
 */
const BEARER_PATTERN = /(?<![G-Z_])Bearer\s+[^\s"',;]+/gi

/**
 * HTTP Basic credentials: `Basic` in the case `Basic`, `basic` or `BASIC`, and a base64 value of
 * at least eight characters that holds an uppercase letter, a digit, `+` or
 * `/`, so prose such as `Basic validation failed` is left alone. Like
 * `Bearer`, it may follow a digit or a hex letter directly. A value followed
 * by `=` or `[` is a key (`Basic Credential=[redacted]`), not a credential.
 */
const BASIC_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- one pattern per rule keeps the rule list the spec
  /(?<![G-Zg-z_])([Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]*[A-Z0-9+/])(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2,3}={0,2})?(?![\w+/=[])/g

/**
 * The separator between a secret-named key and its value: `:`, `=`, `=>`
 * (Node's inspection of a `Map` or `URLSearchParams`), or `:` or `=`
 * encoded for a URL (`%3A`, `%3D`), for HTML (`&#58;`, `&#61;`) or as a
 * JSON escape (`\u003a`, `\u003d`). `=>` is tried first, so `=` never
 * takes half of it.
 */
const KEY_SEPARATOR = String.raw`(?:=>|[:=]|%3[AD]|&#(?:58|61);|\\u003[ad])`

/**
 * The quote that may close a key or open its value: `"` or `'`, possibly
 * escaped (a JSON string inside a JSON string), a URL-encoded `"` (`%22`), or
 * a JSON-escaped quote (`\u0022`, `\u0027`).
 */
const KEY_QUOTE = String.raw`(?:\\?["']|%22|\\u00(?:22|27))`

/**
 * The Authorization scheme words kept in front of a replaced credential.
 */
const AUTH_SCHEMES = String.raw`(?:Bearer|Basic|Token|ApiKey|Digest|Negotiate|NTLM|Hawk|HOBA|DPoP|OAuth|AWS4-HMAC-SHA256|SCRAM-SHA-\d+)`

/**
 * The bare words a secret-named key may hold and keep: `token: undefined`
 * reads as a missing value, not a leaked one.
 */
const BARE_WORD = '(?:undefined|null|missing|true|false)'

/**
 * The lookaheads that keep a value: a placeholder, an unquoted bare word
 * that ends there, or a quoted bare word closed by the same quote that
 * opened it (`"null"`, `\"null\"`); `"null\"hunter2"` is not one.
 */
const KEPT_VALUE = [
  `(?!${PLACEHOLDER})`,
  String.raw`(?!(?<![\\"'])${BARE_WORD}(?=[\s,;&})\]]|$))`,
  String.raw`(?!(?<=(?<!\\)")${BARE_WORD}(?="))`,
  String.raw`(?!(?<=(?<!\\)')${BARE_WORD}(?='))`,
  String.raw`(?!(?<=\\")${BARE_WORD}(?=\\"))`,
  String.raw`(?!(?<=\\')${BARE_WORD}(?=\\'))`,
].join('')

/**
 * A scheme word and the placeholder an earlier rule wrote for its
 * credential (`Bearer [token]`), with anything else up to the next field
 * delimiter, so a secret key holding it is replaced whole.
 */
const SCHEMED_PLACEHOLDER_VALUE = String.raw`${AUTH_SCHEMES}[ \t]+${PLACEHOLDER}(?:[^\n"'\\,;&})\]]*[^\s"'\\,;&})\]])?`

/**
 * An array value, to its first `]` on the line (`["hunter2", "x"]`).
 */
const ARRAY_VALUE = String.raw`\[[^\]\n]*\]`

/**
 * An unquoted value. After a plain `:`, `=` or `=>` it runs to the next field
 * delimiter (`,` `;` `&` `}` `)` `]`, a quote or the end of the line), so a
 * space-separated multi-word value goes whole, and one holding a delimiter
 * stops there; trailing spaces are kept. After an
 * encoded separator (`%3D`) it stops at whitespace too. It never
 * starts with the `>` of an `=>`, so `=` cannot take half of it; a `>` after
 * any other separator is a value. Nor does it start with `%22`, the encoded
 * quote `QUOTED_VALUE` handles, nor with a JSON-escaped one; a lone backslash
 * before the value is skipped (`password=\zq…`).
 */
const UNQUOTED_VALUE = String.raw`(?!%22)(?!\\u00(?:22|27))\\?(?:(?<=[:=>]\s*)(?!(?<==)>)[^\s"'\\,;&})\]](?:[^\n"'\\,;&})\]]*[^\s"'\\,;&})\]])?|(?!(?<==)>)[^\s"'\\,;&})\]][^\s"'\\,;&})\]]*)`

/**
 * A quoted value: inside an escaped quote, up to the next escaped quote;
 * inside a plain quote, up to the quote that opened it (the other quote
 * character is part of the value), escaped quotes included; inside a
 * URL-encoded quote (`%22`) or a JSON-escaped one (`\u0022`), up to the next
 * one.
 */
const QUOTED_VALUE = String.raw`(?<=\\")(?:(?!\\")[^\n])+|(?<=")(?:[^"\\\n]|\\.)+|(?<=')(?:[^'\\\n]|\\.)+|(?<=%22)(?:(?!%22)[^\s"'\\&])+|(?<=\\u00(?:22|27))(?:(?!\\u00(?:22|27))[^\s"'\\]|\\(?!u00(?:22|27)))+`

/**
 * A header-valued key, Authorization (`authorization`, `auth`,
 * `Proxy-Authorization`) or Cookie (`cookie`, `Set-Cookie`), and its whole
 * value. The key, its separator and a known scheme word are kept
 * (`Authorization: Digest [redacted]`). A quoted value is replaced to its
 * closing quote; an unquoted one to the end of the line, so every parameter
 * of a multi-parameter scheme (Digest, OAuth, AWS), the whole credential of
 * an unknown scheme and every pair of a cookie list go.
 */
const AUTH_HEADER_PATTERN = new RegExp(
  String.raw`\b([\w-]*?(?:authorization|auth|cookies?)${KEY_QUOTE}?\s*${KEY_SEPARATOR}\s*${KEY_QUOTE}?(?:${AUTH_SCHEMES}[ \t]+)?)` +
    String.raw`(?!${AUTH_SCHEMES}[ \t]+${PLACEHOLDER})${KEPT_VALUE}` +
    String.raw`(?:${QUOTED_VALUE}|(?=\S)(?<="[ \t]*${AUTH_SCHEMES}[ \t]+)(?:[^"\\\n]|\\.)+|(?=\S)(?<='[ \t]*${AUTH_SCHEMES}[ \t]+)(?:[^'\\\n]|\\.)+|(?!%22)(?!(?<==)>)[^\s"'\\][^\n]*)`,
  'gi'
)

/**
 * A secret-named key, singular or plural, and its value: `password=...`,
 * `"tokens":"..."`, `api_key: ...`, `sig=...`, `nonce=...`,
 * `response="..."`, `SAMLResponse=...`, `password%3D...`, `pass_phrase`,
 * `passkey`, `otp_code`, `mfa_code`, `verification_code`, `recovery_code`,
 * `backup_code`, `code_verifier`. `pin` (and `pin_code`, `pincode`, `pin_number`) is a secret
 * key only as a whole word or after `_` or `-` (`user_pin`, never `spin`). `code` is one
 * only after `?` or `&` (written plainly, as `&amp;`, or encoded as `%3F` or
 * `%26`), first in a form body (`code=…&`), on a line that
 * names OAuth or authorization before it, or with that word later in the same
 * query or JSON object (an authorization code), so `code: 'ECONNREFUSED'` stays;
 * `key` only before `=` (or `%3D`, `&#61;`, `\u003d`), as a whole word or after `_` or `-` (`MY_KEY`), but
 * not in `primary_key`, `foreign_key`, `sort_key`, `object_key`,
 * `routing_key`, `translation_key` and the like; a compound
 * secret key name (`secret_key`, `secretKey`, `private-key`, `signing_key`,
 * `encryption_key`, `master_key`, `client_key`, `consumer_key`) before any
 * separator, `:` included. A `response` key
 * (any prefix) is a key after `=`, `=>`, `%3D`, `&#61;` or `\u003d`, or after `:` or `=>` with a
 * quoted value; after `:` and an unquoted value it is prose (`Unexpected
 * response: 502`) only when `response` stands alone; a prefixed one
 * (`mfa_response`, `SAMLResponse`) is always a key. The key and its separator are kept.
 * The value is a quoted string (spaces and escaped quotes included, also
 * inside a JSON string), an array to its `]`, a scheme word with the
 * placeholder the Bearer or Basic rule wrote (`Bearer [token]`, replaced
 * whole), or an unquoted run
 * (`UNQUOTED_VALUE`). A value
 * already replaced by this scrubber (`[redacted]`, `[token]`...) and the
 * bare words `undefined`, `null`, `missing`, `true` and `false` are left as
 * they are (`KEPT_VALUE`), so `token: undefined` stays readable.
 */
const KV_SECRET_PATTERN = new RegExp(
  String.raw`(?:\b|(?<=%26|%3F))((?:[\w-]*?(?:pass(?:[_-]?(?:word|phrase|code|key)|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|(?:secret|private|consumer|signing|encryption|master|client)[_-]?key|auth(?:orization)?[_-]code|code[_-]?verifier|session|sid|credential|signature|sig|hmac|nonce|(?<=[\w-])response|response(?=s?${KEY_QUOTE}?\s*(?:=|%3D|&#61;|\\u003d|:\s*${KEY_QUOTE}))|(?<![A-Za-z\d])pin(?:[_-]?(?:code|number))?|(?:otp|mfa|verification|recovery|backup)[_-]?code|(?<![A-Za-z\d])(?<!(?:primary|foreign|sort|partition|cache|unique|index|s3|object|routing|shard|translation|i18n)[_-])key(?=s?\s*(?:=(?!>)|%3D|&#61;|\\u003d))|jwt|otp)s?|code(?<=(?:[?&]|&amp;|%26|%3F)code)|code(?<=(?:oauth|authoriz(?:ation|e)(?![a-z]))[^\n]*code)|code(?=\s*=[^\s&]*&)|code(?=[^\n{}]*(?:oauth|authoriz(?:ation|e)(?![a-z]))))${KEY_QUOTE}?\s*${KEY_SEPARATOR}\s*${KEY_QUOTE}?)` +
    `${KEPT_VALUE}(?:${QUOTED_VALUE}|${ARRAY_VALUE}|${SCHEMED_PLACEHOLDER_VALUE}|${UNQUOTED_VALUE})`,
  'gi'
)

/**
 * The words that mark a text as an OAuth exchange: a token request's field
 * names (`grant_type`, `redirect_uri`, `client_id`, `authorization_code`,
 * `code_verifier`), the token endpoint's `invalid_grant` error and the word
 * `OAuth`. A bare `authorization` is left out: a request dump with
 * an Authorization header is not an exchange. A fixed word list with no
 * repetition, so testing it is linear.
 */
const OAUTH_CONTEXT_PATTERN =
  /grant_type|redirect_uri|client_id|authorization_code|invalid_grant|code[_-]?verifier|oauth/i

/**
 * A `code` key and its value, wherever it stands in the text: the same
 * separators, quotes and values as `KV_SECRET_PATTERN`. Applied only to a
 * text that `OAUTH_CONTEXT_PATTERN` matches, so a `code` in a pretty-printed or
 * nested dump of a token request goes, while `{ code: 'ECONNREFUSED' }` in
 * any other text stays.
 */
const CODE_KEY_PATTERN = new RegExp(
  String.raw`\b(code${KEY_QUOTE}?\s*${KEY_SEPARATOR}\s*${KEY_QUOTE}?)` +
    `${KEPT_VALUE}(?:${QUOTED_VALUE}|${ARRAY_VALUE}|${UNQUOTED_VALUE})`,
  'gi'
)

/**
 * A JSON Web Token: three dot-separated base64url segments, the first a
 * base64 JSON object: `eyJ` (`{"`), or, at nine or more characters, `eyA`
 * (`{ `) or `ew` (`{` and a line break or tab). The signature may be empty
 * (an unsigned token). Like `Bearer`, it may follow a digit or a hex letter
 * directly.
 */
const JWT_PATTERN = /(?<![G-Zg-z_])e(?:yJ[\w-]+|(?:yA|w[\w-])[\w-]{6,})\.[\w-]+\.[\w-]*/g

/**
 * A PostHog project, personal or secret key. Applied again after the hex
 * rule, which can leave one glued to the `[secret]` it wrote.
 */
const POSTHOG_KEY_PATTERN = /\bph[cxs]_\w+/g

/**
 * A vendor credential with a known prefix or shape, too short or too plain
 * for the base64 run rule: a Google OAuth client secret (`GOCSPX-`), a
 * Resend API key (`re_`, 16 or more characters with a digit and an uppercase
 * letter, so `re_render` and `re_index_2024_migration` are kept), an AWS access key id (`AKIA`, `ASIA`), a Slack token (`xoxb-`
 * and kin), a Stripe-style live or test key (`sk_live_`, `rk_test_`), a
 * bare Google API key (`AIza` and 35 more), a Stripe webhook secret
 * (`whsec_`). Applied again after the hex rule, like the PostHog key rule.
 */
const VENDOR_KEY_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- one pattern per rule keeps the rule list the spec
  /\b(?:GOCSPX-[\w-]{20,}|re_(?=\w*[A-Z])(?=[A-Za-z_]*\d)\w{16,}|(?:AKIA|ASIA)[\dA-Z]{16}\b|xox[abprs]-[\w-]{10,}|[rs]k_(?:live|test)_\w{10,}|AIza[\w-]{35}(?![\w-])|whsec_[A-Za-z\d+/=]{32,})/g

/**
 * An AWS secret access key: exactly 40 base64 characters with at least one
 * `/` or `+`, on its own between non-base64 characters. An `@` after it makes
 * it an email local part, which the email rules replace whole
 * (`SLASHED_SECRET_EMAIL_PATTERN`). `isAwsSecretKey` then tells it from a
 * 40-character path.
 */
const AWS_SECRET_KEY_PATTERN = /(?<![\w+/-])(?=[A-Za-z\d]*[+/])[A-Za-z\d+/]{40}(?![\w+/=@-])/g

/**
 * The length of an AWS secret access key.
 */
const AWS_SECRET_KEY_LENGTH = 40

/**
 * A run of standard base64 characters only, with no `-` or `_`.
 */
const STANDARD_BASE64_PATTERN = /^[A-Za-z\d+/]+$/

/**
 * An unquoted email local part: a run of address characters in any script.
 */
const EMAIL_LOCAL_PART = String.raw`[\p{L}\p{N}_.%+-]+`

/**
 * An email address after its local part: the `@`, written plainly, as `%40`
 * or `%2540`, or as a fullwidth `＠` or small `﹫`, and the domain, a dotted
 * name ending in a letter label or an IP literal (`[192.168.0.1]`,
 * `[IPv6:…]`), or after a plain `@` a single label that starts with a letter
 * and is not a package or action ref. `EMAIL_PATTERN` describes each form.
 */
const EMAIL_AT_AND_DOMAIN = String.raw`(?:(?:@|%40|%2540|＠|﹫)(?:\[(?:\d{1,3}(?:\.\d{1,3}){3}|IPv6:[\dA-Fa-f:.]+)\]|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})|@(?!(?:npm|workspace|file|github|gitlab|link|portal|patch|git\+[a-z]+):)(?!(?:latest|next|canary|beta|alpha|rc|main|master|sha\d+|v\d[\w.-]*)(?![\p{L}\p{N}-]))\p{L}[\p{L}\p{N}-]*(?=$|[\s"'<>,;:!?&/)\]}]|\.(?:$|\s)))`

/**
 * An email address, in any script. The local part is a run of address
 * characters or a quoted string (`"jane doe"`); the `@` is written plainly,
 * as `%40` or `%2540`, or as a fullwidth `＠` or small `﹫`; the domain is a
 * dotted name ending in a letter label, or an IP literal (`[192.168.0.1]`,
 * `[IPv6:…]`). After a plain `@`, a single label that starts with a letter
 * and ends the word (`jane@localhost`, also before `: ! ? & /`) is an
 * address too; a label that starts with a digit is not, so a package
 * version (`react-dom@19.0.0`) is kept, and neither is a package or action
 * ref (`react@canary`, `actions/checkout@v4`, `node@sha256`,
 * `pkg@workspace:*`, `react@npm:@preact/compat`). The cost: a
 * host named like one of those refs (`jane@main`) is not scrubbed.
 */
const EMAIL_PATTERN = new RegExp(
  String.raw`(?:"[^"\n]{1,64}"|${EMAIL_LOCAL_PART})${EMAIL_AT_AND_DOMAIN}`,
  'gu'
)

/**
 * An email address whose unquoted local part comes straight after a `/`,
 * with the run of base64 characters before that `/` (`abc/def/ghi@…`):
 * `EMAIL_PATTERN`'s local part stops at the `/`, so the part of a secret
 * before it would be kept. The run starts after a character that cannot be
 * part of an address, so it never takes the end of an address before it, and
 * the local part and domain are what `EMAIL_PATTERN` would match at the same
 * place. The match is replaced whole only when `isSlashedSecret` calls the
 * run and the local part's leading base64 characters a secret; otherwise it
 * is left for `EMAIL_PATTERN`, so a path before an address
 * (`/home/jane/x@example.com`) keeps its directories.
 */
const SLASHED_SECRET_EMAIL_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.%+/@＠﹫-])([\w+/-]*/)(${EMAIL_LOCAL_PART})${EMAIL_AT_AND_DOMAIN}`,
  'gu'
)

/**
 * The base64 characters a local part starts with.
 */
const LEADING_BASE64_PATTERN = /^[\w+-]*/

/**
 * One IPv4 octet, 0 to 255.
 */
const IPV4_OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`

/**
 * An IPv4 address: four octets, not part of a longer dotted number.
 */
const IPV4_PATTERN = new RegExp(
  String.raw`(?<![\w.])(?:${IPV4_OCTET}\.){3}${IPV4_OCTET}(?![\w]|\.\d)`,
  'g'
)

/**
 * An IPv6 address: eight hex groups, or a `::` form with at least one
 * group (`::1`, `fe80::1`, `2001:db8::8a2e:370:7334`). A `::` inside a word
 * (`std::vector`) and a clock time (`12:30:45`) are not one; a port after a
 * `::` form (`::1:6379`) reads as one more group and goes with it.
 */
const IPV6_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- one pattern per rule keeps the rule list the spec
  /(?<![\w:])(?:(?:[\dA-Fa-f]{1,4}:){7}[\dA-Fa-f]{1,4}|(?:[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6})?::[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6}|[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6}::)(?![\w:])/g

/**
 * An international phone number: `+`, then 8 to 15 digits, single spaces,
 * dots or hyphens between them (`+1 415 555 0100`).
 */
const PHONE_PATTERN = /(?<![\w+])\+\d(?:[ .-]?\d){7,14}(?!\d)/g

/**
 * A run of 32 or more hex digits: a hash, a token or a key. It is delimited
 * by hex digits rather than word boundaries, so a run stuck to other word
 * characters (`key_<hex>`, `<hex>suffix`) is still replaced. A run glued to
 * a `Bearer [token]` or `Basic [token]` the earlier rules wrote stops before
 * the scheme, whose first letters are hex digits too.
 */
const HEX_RUN_PATTERN =
  /(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{32,}?(?=(?:Bearer|[Bb]asic|BASIC) \[token\])|[0-9A-Fa-f]{32,}(?![0-9A-Fa-f]))/g

/**
 * A run of 40 or more base64 or base64url characters, with its padding.
 */
const BASE64_RUN_PATTERN = /[\w+/-]{40,}={0,2}/g

/**
 * The shortest run `BASE64_RUN_PATTERN` takes.
 */
const SECRET_RUN_MIN = 40

/**
 * The share of a slash-containing run's letters that must be uppercase for
 * it to read as base64 rather than a file path.
 */
const BASE64_UPPERCASE_SHARE = 0.25

/**
 * A run of lowercase words, each at most 20 letters, joined by `-` or `_`:
 * a kebab- or snake-case identifier, never random base64.
 */
const IDENTIFIER_RUN_PATTERN = /^[a-z]{1,20}(?:[-_][a-z]{1,20})+$/

/**
 * Whether an exactly-40-character run with a `/` or `+` is an AWS secret
 * access key rather than a path: at least a quarter of its letters are
 * uppercase. Unlike `isSecretRun`, it needs no digit, so a key without one is
 * caught; a path such as `/app/data/uploads/tenants/avatars/photo1` is almost
 * all lowercase.
 * @param run - The matched run.
 * @returns True when the run should be replaced.
 */
function isAwsSecretKey(run: string): boolean {
  const letters = run.replaceAll(/[^A-Za-z]/g, '')
  const uppercase = run.replaceAll(/[^A-Z]/g, '')
  return uppercase.length >= letters.length * BASE64_UPPERCASE_SHARE
}

/**
 * Whether a long base64-alphabet run is a secret rather than a file path or
 * an identifier. A run with no `/` is, unless it is lowercase words joined
 * by `-` or `_` (`a-very-long-kebab-identifier`). One with a `/` is when it
 * holds a digit and at least a quarter of its letters are uppercase: random
 * base64 is half uppercase, and a path such as
 * `/app/src/services/errors/error-scrubber` is almost all lowercase.
 * @param run - The matched run.
 * @returns True when the run should be replaced.
 */
function isSecretRun(run: string): boolean {
  if (!run.includes('/')) return !IDENTIFIER_RUN_PATTERN.test(run)
  const letters = run.replaceAll(/[^A-Za-z]/g, '')
  const uppercase = run.replaceAll(/[^A-Z]/g, '')
  return uppercase.length >= letters.length * BASE64_UPPERCASE_SHARE && /\d/.test(run)
}

/**
 * Whether a run of base64 characters with a `/`, ending in the base64 start
 * of an email address's local part, is a secret: at least 40 characters, and
 * an AWS secret access key (`isAwsSecretKey`, exactly 40 characters of
 * standard base64) or a run `isSecretRun` calls a secret.
 * @param run - The run before the `/` and the local part's leading base64 characters.
 * @returns True when the run and the address are replaced together.
 */
function isSlashedSecret(run: string): boolean {
  if (run.length < SECRET_RUN_MIN) return false
  const isAwsShaped = run.length === AWS_SECRET_KEY_LENGTH && STANDARD_BASE64_PATTERN.test(run)
  return (isAwsShaped && isAwsSecretKey(run)) || isSecretRun(run)
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
 * or `date/time field value out of range:`, the number in `value "n" is out
 * of range for type`, and the snippet in a V8 `is not valid JSON` error,
 * become `"[value]"`; the userinfo of a URL becomes `[credentials]@`; a
 * URL's, path's or bare word's query string becomes `?[query]`; a fragment,
 * unless a line or heading anchor or a placeholder (`isHarmlessFragment`),
 * becomes `#[fragment]`; the segment after `/reset/`, `/verify/`, `/invite/` or
 * `/accept/` becomes `[token]`; `Bearer <credential>` becomes
 * `Bearer [token]`; `Basic <base64>` becomes `Basic [token]`, the scheme's
 * case kept; an Authorization- or Cookie-valued key's value
 * (`authorization`, `auth`, `cookie`, `set-cookie`), after any known scheme
 * word, to its closing quote or the end of the line, and the value, an
 * array included, of a secret-named key, singular or plural (`password`,
 * `passphrase`, `passcode`, `passkey`, `pin`, `otp_code` and the other
 * one-time code names, `token`, `secret`, `api_key`,
 * `access_key`, `secret_key` and the other compound key names, `session`, `sid`,
 * `credential`, `jwt`, `otp`, `signature`, `sig`, `hmac`, `nonce`,
 * `response`; `code` after `?` or `&` or on an OAuth or authorization line;
 * `key` before `=`; and every `code` in a text that names an OAuth exchange
 * (`OAUTH_CONTEXT_PATTERN`)), become `[redacted]`; a JWT becomes `[jwt]`; an
 * email address (`EMAIL_PATTERN`: `@` written plainly, encoded or fullwidth,
 * a quoted local part, an IP-literal or single-label domain) becomes
 * `[email]`, together with a secret-looking base64 run joined to its local
 * part by `/` (`SLASHED_SECRET_EMAIL_PATTERN`), before the PostHog-key and
 * vendor-credential rules run, so an address whose local part looks like one
 * of those keys goes whole, domain included; a PostHog key (`phc_`, `phx_`,
 * `phs_`) becomes `[posthog-key]` and a vendor credential
 * (`VENDOR_KEY_PATTERN`, or an AWS secret access key) `[secret]`; an
 * IPv4 or IPv6 address becomes `[ip]` and an international phone number
 * `[phone]` (a UUID is an id and is kept); a run of 32 or more hex digits
 * becomes `[secret]`, and a PostHog key or vendor credential glued to it is
 * replaced after it; a secret-looking run of 40 or more base64 characters
 * (`isSecretRun`) becomes `[secret]`; and the result is cut to 1024
 * characters, ending in `…[truncated]`. A key-named word is replaced even in
 * prose (`Missing token: please log in` becomes `Missing token: [redacted]`):
 * the rule trades some readable text for never leaking a value. Applying it
 * twice gives the same text as applying it once, a placeholder in a URL
 * fragment included (`isHarmlessFragment`), except for contrived inputs that
 * glue a phone number, IP address or hex run to one another (a placeholder
 * written by the first pass can open a match for the second).
 * @param value - The text: an exception's type or value, or a frame's filename or function.
 * @returns The scrubbed text.
 */
export function scrubText(value: string): string {
  const input = scanned(value)
  const hasOauthContext = OAUTH_CONTEXT_PATTERN.test(input)
  const scrubbed = input
    .replaceAll(KEY_DETAIL_PATTERN, 'Key ($1)=([value])')
    .replaceAll(PG_INPUT_PATTERN, '$1"[value]"')
    .replaceAll(PG_RANGE_PATTERN, '$1"[value]"')
    .replaceAll(JSON_SNIPPET_PATTERN, '$1"[value]" is not valid JSON')
    .replaceAll(USERINFO_PATTERN, '$1[credentials]@')
    .replaceAll(QUERY_PATTERN, '$1?[query]')
    .replaceAll(FRAGMENT_PATTERN, (match: string, base: string, fragment: string) =>
      isHarmlessFragment(fragment) ? match : `${base}#[fragment]`
    )
    .replaceAll(PATH_TOKEN_PATTERN, '$1[token]')
    .replaceAll(BEARER_PATTERN, 'Bearer [token]')
    .replaceAll(BASIC_PATTERN, '$1 [token]')
    .replaceAll(AUTH_HEADER_PATTERN, '$1[redacted]')
    .replaceAll(KV_SECRET_PATTERN, '$1[redacted]')
    .replaceAll(CODE_KEY_PATTERN, (match: string, key: string) =>
      hasOauthContext ? `${key}[redacted]` : match
    )
    .replaceAll(JWT_PATTERN, '[jwt]')
    .replaceAll(SLASHED_SECRET_EMAIL_PATTERN, (match: string, run: string, local: string) =>
      isSlashedSecret(`${run}${LEADING_BASE64_PATTERN.exec(local)?.[0] ?? ''}`) ? '[email]' : match
    )
    .replaceAll(EMAIL_PATTERN, '[email]')
    .replaceAll(POSTHOG_KEY_PATTERN, '[posthog-key]')
    .replaceAll(VENDOR_KEY_PATTERN, '[secret]')
    .replaceAll(AWS_SECRET_KEY_PATTERN, (run) => (isAwsSecretKey(run) ? '[secret]' : run))
    .replaceAll(IPV4_PATTERN, '[ip]')
    .replaceAll(IPV6_PATTERN, '[ip]')
    .replaceAll(PHONE_PATTERN, '[phone]')
    .replaceAll(HEX_RUN_PATTERN, '[secret]')
    .replaceAll(POSTHOG_KEY_PATTERN, '[posthog-key]')
    .replaceAll(VENDOR_KEY_PATTERN, '[secret]')
    .replaceAll(AWS_SECRET_KEY_PATTERN, (run) => (isAwsSecretKey(run) ? '[secret]' : run))
    .replaceAll(BASE64_RUN_PATTERN, (run) => (isSecretRun(run) ? '[secret]' : run))
  return capped(scrubbed, input.length < value.length)
}
