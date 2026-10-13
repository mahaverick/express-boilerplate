/**
 * @file The one rule set that removes personal data and secrets from text
 * before it leaves the process for a third party: an exception's type and
 * value, a stack frame's filename and function, and the other text callers
 * pass, such as a log line. express-boilerplate
 * (src/services/errors/error-scrubber.service.ts) and the react and apex
 * clients (src/observability/errors/scrub.ts) hold this file byte for byte,
 * and all three test it against one vector file
 * (tests/fixtures/error-scrub-vectors.json), so a rule changes in all three
 * and in that file together.
 *
 * The rules run in a fixed order over a view of the text. Each rule's
 * matches are applied to the view at once, as `String.replaceAll` would, and
 * every character of the view remembers the span of the original text it
 * stands for (`View`). A secret-named key that an earlier rule swallowed
 * into a placeholder is found again in the original text, and its value is
 * redacted after every other rule in the pass (`tokenKeyRanges`), so that
 * redaction does not hide text a rule reads.
 */

/**
 * The longest text kept, the marker included.
 */
export const SCRUB_VALUE_MAX = 1024

/**
 * What ends a text cut to `SCRUB_VALUE_MAX` characters.
 */
export const TRUNCATION_MARKER = '…[truncated]'

/**
 * The most characters the rules scan: four times what is kept, so a text
 * the rules shorten can still fill the cap, while the input every regex runs
 * over stays bounded.
 */
const SCAN_MAX = 4 * SCRUB_VALUE_MAX

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
 * type X: "value"`, `invalid input value for enum X: "value"`, `malformed X
 * literal: "value"` and `date/time field value out of range: "value"`. A
 * doubled quote inside the value does not end it.
 */
const PG_INPUT_PATTERN =
  /(invalid input (?:syntax for type|value for enum) [\w." ]+?: |malformed \w+ literal: |date\/time field value out of range: )"(?:[^"]|"")*"/g

/**
 * The value Postgres echoes back in `value "<n>" is out of range for type
 * X`: the quoted value is replaced and the rest kept.
 */
const PG_RANGE_PATTERN = /\b(value )"(?:[^"]|"")*"(?= is out of range for type)/g

/**
 * The snippet V8 echoes in a JSON parse error: `"<text>"... is not valid JSON`.
 * It matches at the start of a line or after whitespace or `(`.
 */
const JSON_SNIPPET_PATTERN = /(^|[\s(])(?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/gm

/**
 * A URL's userinfo, a user and password (`scheme://user:pass@host`) or a
 * user alone. The scheme and `://` are kept. The userinfo runs to the last
 * `@` before a `/`, `?`, `#`, `<`, `>` or whitespace, `@` inside it included.
 * A quote ends the userinfo when a delimiter (`,` `:` `;` `}` `]` or
 * whitespace) follows it, so it never spans from one JSON field into the
 * next.
 */
const USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#<>"']|["'](?![,:;}\]\s]))+@/gi

/**
 * A URL or path followed by a query string: the part before `?` is kept. A
 * bare word before `?` (`callback?code=…`) counts as a path when the query
 * holds an `=`, so a question in prose is left alone. A word after `@` is
 * a domain, which the email rule handles; the query after an address in a
 * URL with no `//` (`mailto:jane@…?subject=…`) is `EMAIL_QUERY_PATTERN`'s.
 */
const QUERY_PATTERN =
  /((?:https?:\/\/|\/)[^\s?"'<>]*|(?<![@\w.-])[\w.-]+(?=\?[^\s"'<>]*=))\?[^\s"'<>]+/g

/**
 * The placeholders this scrubber writes. A key's value that starts with one
 * (`KEPT_VALUE`) and a URL fragment that is one (`isHarmlessFragment`) are
 * left as they are.
 */
const PLACEHOLDER = String.raw`\[(?:redacted|value|credentials|query|fragment|token|jwt|posthog-key|email|secret|ip|phone)\]`

/**
 * An email address's IP-literal domain: `[192.168.0.1]` or `[IPv6:…]`.
 */
const EMAIL_IP_LITERAL = String.raw`\[(?:\d{1,3}(?:\.\d{1,3}){3}|IPv6:[\dA-Fa-f:.]+)\]`

/**
 * A URL's or path's fragment: the part before `#` is kept, and so is a
 * fragment `isHarmlessFragment` accepts.
 */
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
 * `state`, `session`, `auth`, `pass`, `password`, `passcode`, `passphrase`,
 * `nonce`, `sig`, `signature`, `credential`, `jwt` or `bearer`, most with a
 * plural `s`. Whole words only, so `authentication`, `design` and
 * `keyboard-shortcuts` are kept.
 */
const KEY_LIKE_WORD_PATTERN =
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
 * a token however short (`/reset/abc123XYZ`). The prefix is kept. The
 * segment stops before a `,` or `;` followed by a `Bearer` or `Basic` scheme
 * word and whitespace, so that credential is left to its own rule.
 */
const PATH_TOKEN_PATTERN =
  /(\/(?:reset|verify|invite|accept)\/)(?!\[)(?:(?![,;](?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc])\s)[^\s/?#"'<>])+/g

/**
 * `Bearer`, in any letter case, and the credential after it, up to
 * whitespace, a quote, `,` or `;`. It may follow anything but a letter from
 * `g` to `z` or `_` (the case-insensitive `[G-Z_]`), so one glued to a long
 * hex run is replaced before the hex rule takes the run and `Be` with it.
 */
const BEARER_PATTERN = /(?<![G-Z_])Bearer\s+[^\s"',;]+/gi

/**
 * HTTP Basic credentials: `Basic` in any letter case, whitespace, and a
 * base64 value of at least eight characters that holds an uppercase letter, a
 * digit, `+` or `/`. So `Basic validation failed` is left alone, but
 * capitalised prose (`Basic Authentication required`) is taken. Like
 * `Bearer`, it may follow anything but a letter from `g` to `z` or `_`. A
 * value followed by `=` or `[` is a key (`Basic Credential=[redacted]`), not a
 * credential.
 */
const BASIC_PATTERN =
  /(?<![G-Zg-z_])([Bb][Aa][Ss][Ii][Cc])\s+(?=[A-Za-z0-9+/]*[A-Z0-9+/])(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2,3}={0,2})?(?![\w+/=[])/g

/**
 * The separator between a secret-named key and its value: `:`, `=`, `=>`
 * (Node's inspection of a `Map` or `URLSearchParams`), or `:` or `=`
 * encoded for a URL (`%3A`, `%3D`), for HTML (`&#58;`, `&#61;`) or as a
 * JSON escape (`\u003a`, `\u003d`). `=>` is tried first, and
 * `UNQUOTED_VALUE` refuses a value that starts with its `>`, so `=` never
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
 * The Authorization scheme words, in any letter case. `AUTH_HEADER_PATTERN`
 * keeps one in front of the value it replaces; `SCHEMED_PLACEHOLDER_VALUE`
 * replaces one along with the placeholder after it.
 */
const AUTH_SCHEMES = String.raw`(?:Bearer|Basic|Token|ApiKey|Digest|Negotiate|NTLM|Hawk|HOBA|DPoP|OAuth|AWS4-HMAC-SHA256|SCRAM-SHA-\d+)`

/**
 * The bare words a secret-named key may hold and keep: `token: undefined`
 * reads as a missing value, not a leaked one.
 */
const BARE_WORD = '(?:undefined|null|missing|true|false)'

/**
 * The lookaheads that keep a value: one that starts with a placeholder,
 * with anything glued to it (`token=[redacted]x` stays as it is); an unquoted
 * bare word that ends there; or a quoted bare word closed by the same quote
 * that opened it (`"null"`, `\"null\"`); `"null\"hunter2"` is not one. A
 * URL-encoded or JSON-escaped quote (`%22null%22`) does not keep it.
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
 * A `Bearer [token]` or `Basic [token]` an earlier rule wrote, the scheme's
 * letter case aside.
 */
const SCHEME_PLACEHOLDER = String.raw`(?:Bearer|[Bb][Aa][Ss][Ii][Cc]) \[token\]`

/**
 * One `key=value` pair after a replaced scheme credential, joined by `,` or `;`
 * with whitespace, line breaks included, on either side
 * (`Bearer [token],refresh=xyz`): another credential or cookie may sit there.
 * The `=` may be URL-encoded (`%3D`). The value is a JSON-escaped quoted
 * string (`\"…\"`) closed before whitespace, `,`, `;`, a quote, a backslash
 * or the end of the text; a quoted string closed before whitespace, `,`, `;`
 * or the end; a quoted string left open to the end of its line; or else an
 * unquoted run that may hold a placeholder a key rule wrote
 * (`,password=[redacted]`) and stops before another scheme placeholder, so
 * that credential starts its own match.
 */
const SCHEME_TAIL_PAIR = String.raw`\s*[,;]\s*[\w.-]+(?:=|%3[Dd])(?:\\"[^"\\\n]*\\"(?=[\s,;"\\]|$)|"[^"\\\n]*"(?=[\s,;]|$)|"[^"\\\n]*(?=\n|$)|'[^'\\\n]*'(?=[\s,;]|$)|(?:${PLACEHOLDER}|(?!${SCHEME_PLACEHOLDER})[^\s"'\\,;&})\]])*)`

/**
 * The `Bearer [token]` or `Basic [token]` an earlier rule wrote, with the pairs
 * joined to it. Group 1, and any whitespace before the first pair's own `,`
 * or `;`, is kept; the pairs become `[redacted]` after that separator. It runs
 * after every other rule but the last key redaction. A header-valued key
 * (`, cookie=OAuth abc`) or an array value is redacted past the first
 * whitespace or `]`, where this rule stops, and a phone number, address or
 * secret in a pair is replaced whole, so taking the pair first would leave
 * the rest of the value, or of the number, in view. It may follow any
 * character (`0100Bearer [token]`), so a pass that turns what precedes it
 * into a placeholder does not change whether it matches. It misses a pair
 * whose credential a secret key's value already took
 * (`token=Bearer abc,refresh=xyz` keeps `,refresh=xyz`), a quote inside an
 * unquoted value (`,a=b"x"` keeps `"x"`), a quoted value glued to more text
 * or split by a line break (`,a=""x`, `,a="x\ny"`), a credential the Bearer
 * or Basic rule does not take (`xBearer abc`, `_Bearer abc`, `gBasic …`: a
 * scheme word glued to a letter from `g` to `z` or a `_`), and a fully
 * URL-encoded header (`Bearer%20abc%2Crefresh%3Dxyz`).
 */
const SCHEME_TAIL_PATTERN = new RegExp(
  `(${SCHEME_PLACEHOLDER})(${SCHEME_TAIL_PAIR}(?:${SCHEME_TAIL_PAIR})*)`,
  'g'
)

/**
 * An array value, to its first `]` on the line (`["hunter2", "x"]`).
 */
const ARRAY_VALUE = String.raw`\[[^\]\n]*\]`

/**
 * A bracketed token inside an unquoted value that is taken whole, so its `]`
 * does not end the value: a placeholder an earlier rule wrote
 * (`https://example.com/x#[fragment]`) or an address's IP literal
 * (`jane@[192.168.0.1]`).
 */
const VALUE_BRACKETED = `(?:${PLACEHOLDER}|${EMAIL_IP_LITERAL})`

/**
 * One character of an unquoted value that may end it, or a bracketed token.
 * A bracketed token's `[` is never taken as a lone character, so a match
 * cannot back off into the token and end before its `]`.
 */
const VALUE_END_UNIT = String.raw`(?:${VALUE_BRACKETED}|(?!${VALUE_BRACKETED})[^\s"'\\,;&})\]])`

/**
 * An HTML- or JSON-encoded `:` or `=` inside an unquoted value (`&#58;`,
 * `&#61;`, `\u003a`, `\u003d`), taken whole, so its `&` or backslash does
 * not end the value.
 */
const VALUE_ENCODED_SEPARATOR = String.raw`(?:&#(?:58|61);|\\u003[ad])`

/**
 * A separator inside an unquoted value, plain or encoded (`%3D`, `&#61;`,
 * `\u003d`), and the whitespace after it: what a nested quoted string or
 * array follows.
 */
const VALUE_NESTED_SEPARATOR = String.raw`(?:[:=]|=>|%3[AD]|${VALUE_ENCODED_SEPARATOR})\s*`

/**
 * A quoted string or an array straight after a separator inside an unquoted
 * value (`token: a session="…"`, `token: a pwd = \"…\"`, `token: a pwd =
 * [x, y]`): a quote as `QUOTED_VALUE` takes it (plain, escaped or
 * JSON-escaped, `\u0022` or `\u0027`), to its closing quote or the end of
 * the line; a URL-encoded one (`%22`) to its closing `%22`, whitespace, a
 * quote, a backslash or `&`; or an array to its first `]`. So the quoted or
 * array value of a key written inside the value goes with the value.
 */
const VALUE_NESTED_QUOTED = String.raw`(?=["'\\%[])(?<=${VALUE_NESTED_SEPARATOR})(?:"(?:[^"\\\n]|\\.)*(?:"|(?=\n|$))|'(?:[^'\\\n]|\\.)*(?:'|(?=\n|$))|\\"(?:(?!\\")[^\n])*(?:\\"|(?=\n|$))|\\'(?:(?!\\')[^\n])*(?:\\'|(?=\n|$))|\\u0022(?:(?!\\u0022)[^\n])*(?:\\u0022|(?=\n|$))|\\u0027(?:(?!\\u0027)[^\n])*(?:\\u0027|(?=\n|$))|%22(?:(?!%22)[^\s"'\\&])*(?:%22)?|${ARRAY_VALUE})`

/**
 * One character inside an unquoted value after a plain separator, a space
 * included, a bracketed token, a nested quoted string or array, or an
 * encoded separator. A nested array's `[` is never taken as a lone
 * character, so the value cannot stop inside the array.
 */
const VALUE_INNER_UNIT = String.raw`(?:${VALUE_BRACKETED}|${VALUE_NESTED_QUOTED}|${VALUE_ENCODED_SEPARATOR}|(?!${VALUE_BRACKETED})(?!\[(?<=${VALUE_NESTED_SEPARATOR}\[)[^\]\n]*\])[^\n"'\\,;&})\]])`

/**
 * The last unit of an unquoted value after a plain separator, or any unit of
 * one after an encoded separator: one that may end it, a nested quoted string
 * or array, or an encoded separator.
 */
const VALUE_LAST_UNIT = `(?:${VALUE_NESTED_QUOTED}|${VALUE_ENCODED_SEPARATOR}|${VALUE_END_UNIT})`

/**
 * An unquoted value. Directly after a plain `:`, `=` or `=>` (whitespace
 * between allowed) it runs to the next field delimiter (`,` `;` `&` `}` `)` `]`, a
 * quote, a backslash or the end of the line), so a space-separated multi-word
 * value goes whole, and one holding a delimiter stops there; trailing spaces
 * are kept. A quoted string or array after a plain or encoded separator
 * inside it goes with it (`VALUE_NESTED_QUOTED`), and so does an HTML- or
 * JSON-encoded separator (`&#61;`, `\u003d`), so the quoted value of a key
 * written inside the value goes too. After an encoded separator (`%3D`,
 * `&#61;`, `\u003d`), or when the value starts with a backslash, it also
 * stops at whitespace outside such a quoted string (`password=\zq a b`
 * keeps ` a b`). A placeholder an earlier rule wrote inside the value (a
 * URL's `#[fragment]` or `?[query]`) and an address's IP literal are part of
 * it (`VALUE_BRACKETED`), so their `]` never ends the value early. It never
 * starts with the `>` of an `=>`, so `=` cannot take half of it; a `>` after
 * any other separator is a value. Nor does it start with `%22`, the encoded
 * quote `QUOTED_VALUE` handles, nor with a JSON-escaped one; a lone backslash
 * before the value is part of the match (`password=\zq…`).
 */
const UNQUOTED_VALUE = String.raw`(?!%22)(?!\\u00(?:22|27))\\?(?:(?<=[:=>]\s*)(?!(?<==)>)${VALUE_END_UNIT}(?:${VALUE_INNER_UNIT}*${VALUE_LAST_UNIT})?|(?!(?<==)>)${VALUE_END_UNIT}${VALUE_LAST_UNIT}*)`

/**
 * A quoted value: inside an escaped quote, up to the next escaped quote or
 * the end of the line; inside a plain quote, up to the quote that opened it
 * or the end of the line (the other quote character is part of the value),
 * escaped quotes included; inside a URL-encoded quote (`%22`), up to the next
 * one, whitespace, a quote, a backslash or `&`; inside a JSON-escaped one
 * (`\u0022`, `\u0027`), up to the next JSON-escaped quote, whitespace or a
 * quote. The closing quote is not part of it.
 */
const QUOTED_VALUE = String.raw`(?<=\\")(?:(?!\\")[^\n])+|(?<=")(?:[^"\\\n]|\\.)+|(?<=')(?:[^'\\\n]|\\.)+|(?<=%22)(?:(?!%22)[^\s"'\\&])+|(?<=\\u00(?:22|27))(?:(?!\\u00(?:22|27))[^\s"'\\]|\\(?!u00(?:22|27)))+`

/**
 * A header-valued key, one ending in `authorization`, `auth`, `cookie` or
 * `cookies` (`Proxy-Authorization`, `Set-Cookie`), and its value. The key,
 * its separator and a known scheme word are kept (`Authorization: Digest
 * [redacted]`). A quoted value is replaced to its closing quote; an unquoted
 * one to the end of the line, so every parameter of a multi-parameter scheme
 * (Digest, OAuth, AWS), the whole credential of an unknown scheme and every
 * pair of a cookie list go. A value `KEPT_VALUE` keeps, and a scheme the
 * Bearer or Basic rule already replaced (`Bearer [token]`), are left with
 * the rest of the line (`Authorization: Bearer [token] def` keeps ` def`).
 */
const AUTH_HEADER_PATTERN = new RegExp(
  String.raw`\b([\w-]*?(?:authorization|auth|cookies?)${KEY_QUOTE}?\s*${KEY_SEPARATOR}\s*${KEY_QUOTE}?(?:${AUTH_SCHEMES}[ \t]+)?)` +
    String.raw`(?!${AUTH_SCHEMES}[ \t]+${PLACEHOLDER})${KEPT_VALUE}` +
    String.raw`(?:${QUOTED_VALUE}|(?=\S)(?<="[ \t]*${AUTH_SCHEMES}[ \t]+)(?:[^"\\\n]|\\.)+|(?=\S)(?<='[ \t]*${AUTH_SCHEMES}[ \t]+)(?:[^'\\\n]|\\.)+|(?!%22)(?!(?<==)>)[^\s"'\\][^\n]*)`,
  'gi'
)

/**
 * The key part of `KV_SECRET_PATTERN`, group 1: a secret-named key, its
 * separator and the quotes around them, all kept. A secret-named key, in any
 * letter case, is any run of word characters and `-` that ends in one of
 * these words or its plural, before any separator, `:` included:
 * `pass`, `password`, `passwd`, `passphrase`, `passcode`, `passkey`, `pwd`,
 * `secret`, `token`, `api_key`, `access_key`, a compound key name
 * (`secret_key`, `secretKey`, `private-key`, `signing_key`,
 * `encryption_key`, `master_key`, `client_key`, `consumer_key`),
 * `auth_code`, `authorization_code`, `code_verifier`, `session`, `sid`,
 * `credential`, `signature`, `sig`, `hmac`, `nonce`, a one-time code name
 * (`otp_code`, `mfa_code`, `verification_code`, `recovery_code`,
 * `backup_code`), `jwt` or `otp`. So `user_pass`, `userPass`,
 * `userpassword` and `db_password` count too, but the words `compass`,
 * `encompass`, `bypass` and `surpass` on their own, with no letter,
 * digit, `_`, `-` or `.` before them, do not (`compass: north` is kept);
 * every other key ending in `pass` counts, a compound of those words
 * included (`dbpass`, `auth_bypass`, `x-vercel-protection-bypass`). Some
 * words count only in context:
 * - `pin` (and `pin_code`, `pincode`, `pin_number`) only as a whole word or
 *   after `_` or `-` (`user_pin`, never `spin`).
 * - `key` or `keys` only unquoted and before `=` (not `=>`), `%3D`, `&#61;`
 *   or `\u003d`, with only whitespace between (`key = abc`), as a whole word
 *   or after `_` or `-` (`MY_KEY`), and not
 *   after `primary`, `foreign`, `sort`, `partition`, `cache`, `unique`,
 *   `index`, `s3`, `object`, `routing`, `shard`, `translation` or `i18n` and
 *   a `_` or `-`.
 * - `response` with a prefix (`mfa_response`, `SAMLResponse`) always; alone,
 *   only before `=`, `%3D`, `&#61;` or `\u003d`, or before `:` and a quoted
 *   value, so `Unexpected response: 502` is prose.
 * - `code` alone, starting a word or after `%26` or `%3F`, only: after `?`
 *   or `&` (written plainly, as `&amp;`, or encoded as `%3F` or `%26`);
 *   before `=`, a value with no whitespace and `&` (`code=…&`); with
 *   `oauth`, `authorization` or `authorize` earlier on the same line; or with
 *   one of those words later on the same line and no `{` or `}` between. So
 *   `code: 'ECONNREFUSED'` stays.
 * A URL fragment the fragment rule replaced (`#[fragment] = …`) counts as a
 * key too, since the fragment may have ended in one.
 */
const KV_SECRET_KEY = String.raw`(?:\b|(?<=%26|%3F)|(?<=#)(?=\[fragment\]))((?:(?<=#)\[fragment\]|[\w-]*?(?:pass(?:[_-]?(?:word|phrase|code|key)|wd|(?<!(?<![\w.-])(?:(?:en)?com|by|sur)pass))|pwd|secret|token|api[_-]?key|access[_-]?key|(?:secret|private|consumer|signing|encryption|master|client)[_-]?key|auth(?:orization)?[_-]code|code[_-]?verifier|session|sid|credential|signature|sig|hmac|nonce|(?<=[\w-])response|response(?=s?${KEY_QUOTE}?\s*(?:=|%3D|&#61;|\\u003d|:\s*${KEY_QUOTE}))|(?<![A-Za-z\d])pin(?:[_-]?(?:code|number))?|(?:otp|mfa|verification|recovery|backup)[_-]?code|(?<![A-Za-z\d])(?<!(?:primary|foreign|sort|partition|cache|unique|index|s3|object|routing|shard|translation|i18n)[_-])key(?=s?\s*(?:=(?!>)|%3D|&#61;|\\u003d))|jwt|otp)s?|code(?<=(?:[?&]|&amp;|%26|%3F)code)|code(?<=(?:oauth|authoriz(?:ation|e)(?![a-z]))[^\n]*code)|code(?=\s*=[^\s&]*&)|code(?=[^\n{}]*(?:oauth|authoriz(?:ation|e)(?![a-z]))))${KEY_QUOTE}?\s*${KEY_SEPARATOR}\s*${KEY_QUOTE}?)`

/**
 * The value grammar of `KV_SECRET_PATTERN`. A value `KEPT_VALUE` keeps (one
 * that starts with a placeholder, or a bare word such as `undefined`) fails
 * it, so `token: undefined` stays readable. Otherwise the value is, tried in
 * this order, a quoted string (spaces and escaped quotes included, also
 * inside a JSON string), an array to its `]`, a scheme word with the
 * placeholder the Bearer or Basic rule wrote and the rest of the field
 * (`Bearer [token]`, replaced whole), or an unquoted run (`UNQUOTED_VALUE`).
 */
const KV_SECRET_VALUE = `${KEPT_VALUE}(?:${QUOTED_VALUE}|${ARRAY_VALUE}|${SCHEMED_PLACEHOLDER_VALUE}|${UNQUOTED_VALUE})`

/**
 * `KV_SECRET_KEY` and `KV_SECRET_VALUE`: a secret-named key and its value.
 */
const KV_SECRET_PATTERN = new RegExp(KV_SECRET_KEY + KV_SECRET_VALUE, 'gi')

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
 * A `code` key that starts a word, and its value, wherever it stands in the
 * text: the same separators, quotes and values as `KV_SECRET_PATTERN`, except
 * a scheme with its placeholder (`SCHEMED_VALUE_AT`). Applied only to a
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
 * `KV_SECRET_PATTERN`, matching only at `lastIndex`.
 */
const KV_SECRET_AT = new RegExp(KV_SECRET_PATTERN.source, 'iy')

/**
 * `AUTH_HEADER_PATTERN`, matching only at `lastIndex`.
 */
const AUTH_HEADER_AT = new RegExp(AUTH_HEADER_PATTERN.source, 'iy')

/**
 * `CODE_KEY_PATTERN`, matching only at `lastIndex`.
 */
const CODE_KEY_AT = new RegExp(CODE_KEY_PATTERN.source, 'iy')

/**
 * A scheme word and the placeholder an earlier rule wrote for its credential
 * (`SCHEMED_PLACEHOLDER_VALUE`), only at `lastIndex`: a value the OAuth
 * `code` rule runs through, since that rule's own value grammar has no such
 * form, and after an encoded separator (`code%3DBearer [token]`) its unquoted
 * value would stop at the scheme word.
 */
const SCHEMED_VALUE_AT = new RegExp(SCHEMED_PLACEHOLDER_VALUE, 'iy')

/**
 * What may follow the end of a value a later key took over: its closing
 * quote and any text glued to it, up to whitespace or the next field
 * delimiter, only at `lastIndex`.
 */
const GLUED_TAIL_AT = new RegExp(String.raw`${KEY_QUOTE}?[^\s"'\\,;&})\]]*`, 'y')

/**
 * Where a key rule's value ends once it runs through later keys: when one of
 * `innerKeys` matches at a position inside the value and runs past its end
 * (the value took that key's name, separator or opening quote), the value
 * runs on to the end of that match, then over a closing quote and any text
 * glued to it (`GLUED_TAIL_AT`), and is checked again. So the value of a key
 * that starts inside this value is replaced with it.
 * @param text - The text being scrubbed.
 * @param valueStart - Where the value starts.
 * @param matchEnd - Where the key rule's own match ends.
 * @param innerKeys - Sticky key rules a later key is looked for with:
 *   `KV_SECRET_AT` and `AUTH_HEADER_AT`, and `CODE_KEY_AT` in a text that
 *   names an OAuth exchange (with `SCHEMED_VALUE_AT` for the `code` rule
 *   itself).
 * @returns The end of the value, at or after `matchEnd`.
 */
function runThroughEnd(
  text: string,
  valueStart: number,
  matchEnd: number,
  innerKeys: readonly RegExp[]
): number {
  let end = matchEnd
  let at = valueStart
  for (;;) {
    for (; at < end && end < text.length; at += 1) {
      for (const sticky of innerKeys) end = Math.max(end, pairEndAt(sticky, text, at))
    }
    if (end === matchEnd) return end
    GLUED_TAIL_AT.lastIndex = end
    const glued = GLUED_TAIL_AT.exec(text)?.[0].length ?? 0
    if (glued === 0) return end
    end += glued
  }
}

/**
 * Where a key rule's match starting exactly at `at` ends, or `at` when it
 * does not match there.
 * @param sticky - A key rule with the `y` flag.
 * @param text - The text being scrubbed.
 * @param at - The position to try.
 * @returns The end of the match, or `at`.
 */
function pairEndAt(sticky: RegExp, text: string, at: number): number {
  sticky.lastIndex = at
  const pair = sticky.exec(text)
  return pair === null ? at : at + pair[0].length
}

/**
 * A JSON Web Token: three dot-separated base64url segments, the first a
 * base64 JSON object: `eyJ` (`{"`), or, at nine or more characters, `eyA`
 * (`{ `) or `ew` (`{` and a line break or tab). The signature may be empty
 * (an unsigned token). Like `Bearer`, it may follow anything but a letter
 * from `g` to `z` or `_`.
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
 * Resend API key (`re_` and 16 or more characters with a digit and an
 * uppercase letter, so `re_render` and `re_index_2024_migration` are kept),
 * an AWS access key id (`AKIA`, `ASIA`), a Slack token (`xoxb-` and kin), a Stripe-style live or test key (`sk_live_`, `rk_test_`), a
 * bare Google API key (`AIza` and 35 more), a Stripe webhook secret
 * (`whsec_`). Applied again after the hex rule, like the PostHog key rule.
 */
const VENDOR_KEY_PATTERN =
  /\b(?:GOCSPX-[\w-]{20,}|re_(?=\w*[A-Z])(?=[A-Za-z_]*\d)\w{16,}|(?:AKIA|ASIA)[\dA-Z]{16}\b|xox[abprs]-[\w-]{10,}|[rs]k_(?:live|test)_\w{10,}|AIza[\w-]{35}(?![\w-])|whsec_[A-Za-z\d+/=]{32,})/g

/**
 * An AWS secret access key: exactly 40 base64 characters with at least one
 * `/` or `+`, not straight after a letter, digit, `_`, `+`, `/` or `-`,
 * and not straight before a letter, digit, `_`, `+`, `=` or `-`. The email
 * rules run first and replace a key followed by `@` with the address when
 * they accept the domain (`SLASHED_SECRET_EMAIL_PATTERN`); before a domain
 * they refuse (`@main`) this rule replaces the key and keeps the `@main`.
 * `isAwsSecretKey` then tells it from a 40-character path. A key followed
 * by `/` is handled only after the hex rule (`applyKeyShapes`).
 */
const AWS_SECRET_KEY_PATTERN = /(?<![\w+/-])(?=[A-Za-z\d]*[+/])[A-Za-z\d+/]{40}(?![\w+=-])/g

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
 * Not a package or action ref after `@` (`npm:…`, `workspace:…`, `canary`,
 * `v4`, `sha256`), which a single-label domain must not be.
 */
const NOT_PACKAGE_REF = String.raw`(?!(?:npm|workspace|file|github|gitlab|link|portal|patch|git\+[a-z]+):)(?!(?:latest|next|canary|beta|alpha|rc|main|master|sha\d+|v\d[\w.-]*)(?![\p{L}\p{N}-]))`

/**
 * An email address after its local part: the `@`, written plainly, as `%40`
 * or `%2540`, or as a fullwidth `＠` or small `﹫`, and the domain, a dotted
 * name ending in a letter label or an IP literal (`[192.168.0.1]`,
 * `[IPv6:…]`), or after a plain `@` a single label that starts with a letter
 * and is not a package or action ref. `EMAIL_PATTERN` describes each form.
 */
const EMAIL_AT_AND_DOMAIN = String.raw`(?:(?:@|%40|%2540|＠|﹫)(?:${EMAIL_IP_LITERAL}|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})|@${NOT_PACKAGE_REF}\p{L}[\p{L}\p{N}-]*(?=$|[\s"'<>,;:!?&/)\]}]|\.(?:$|\s)))`

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
 * The query of a URL whose path is addresses the email rule replaced, after
 * a scheme of at most 32 characters and no `//` (`mailto:[email]?subject=…`,
 * `mailto:[email],[email]?cc=…`, `xmpp:[email]?message;body=…`), or straight
 * after `mailto:` (`mailto:?to=…`); addresses may be joined by `,` or `;`,
 * with whitespace after, or by an encoded `%2C` or `%3B` that the email rule
 * already took into the next address (`mailto:[email][email]?…`). The query
 * rule takes no word after `@`, so this query is left to this rule, which
 * runs after every other rule but `SCHEME_TAIL_PATTERN` and the last key
 * redaction, so a phone number, IP address or secret in the query is
 * replaced whole first. Group 1, the
 * scheme and the addresses, is kept and the rest of the query, up to
 * whitespace, a quote, `<` or `>`, becomes `?[query]`, as the query rule
 * writes it. A bare address before `?` (`jane@localhost?x=1`) is not a URL,
 * and its query is kept.
 */
const EMAIL_QUERY_PATTERN =
  /(?<![a-z\d+.-])((?:mailto:(?:\[email\])?|[a-z][a-z\d+.-]{0,31}:\[email\])(?:(?:[,;]\s*)?\[email\])*)\?[^\s"'<>]+/gi

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
 * An address whose domain is a run of base64 characters with a `/` in it
 * (`x@wJalr…/K7MDENG/…`): `EMAIL_PATTERN` would take only the run's first
 * segment as a single-label domain and leave the rest of a secret in view.
 * Group 1 is the run; the match is replaced whole when `isSlashedSecret`
 * calls the run a secret. The local part starts only where one can start
 * and not straight after a `/` or `@` (`SLASHED_SECRET_EMAIL_PATTERN`'s
 * case), so a long local part is scanned once, and a package ref
 * (`x@canary/…`) is not a domain.
 */
const ADDRESS_SECRET_DOMAIN_PATTERN = new RegExp(
  String.raw`(?:"[^"\n]{1,64}"|(?<![\p{L}\p{N}_.%+/@＠﹫-])${EMAIL_LOCAL_PART})@${NOT_PACKAGE_REF}([A-Za-z][A-Za-z\d+/-]*\/[A-Za-z\d+/-]*={0,2})(?![\w+/=@-])`,
  'gu'
)

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
  /(?<![\w:])(?:(?:[\dA-Fa-f]{1,4}:){7}[\dA-Fa-f]{1,4}|(?:[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6})?::[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6}|[\dA-Fa-f]{1,4}(?::[\dA-Fa-f]{1,4}){0,6}::)(?![\w:])/g

/**
 * The head of an IPv6 address whose last group an earlier rule took into a
 * `[secret]` or `[email]` (`2001:db8::8a2e:370:[secret]`, where an AWS-shaped
 * run took `7334/…`): three to eight colon-joined hex groups, or groups
 * that hold a `::`, that start after neither a word character nor a `:` and
 * end in the `:` before the placeholder. So two groups with no `::`, such as
 * a time or a port pair (`80:443:[email]`), are kept. `IPV6_PATTERN` refuses
 * an address followed by `[`, so the head would stay in view.
 */
const IPV6_HEAD_PATTERN =
  /(?<![\w:])(?:(?:[\dA-Fa-f]{1,4}:){3,8}|(?:(?:[\dA-Fa-f]{1,4}:){1,7}:|::)(?:[\dA-Fa-f]{1,4}:){0,6})(?=\[(?:secret|email)\])/g

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
 * The share of a run's letters that must be uppercase for a run with a `/`
 * (or, for `isAwsSecretKey`, a `+`) to read as base64 rather than a file
 * path.
 */
const BASE64_UPPERCASE_SHARE = 0.25

/**
 * Two or more lowercase words, each at most 20 letters, joined by `-` or `_`:
 * a kebab- or snake-case identifier, which random base64 almost never is.
 */
const IDENTIFIER_RUN_PATTERN = /^[a-z]{1,20}(?:[-_][a-z]{1,20})+$/

/**
 * Whether a 40-character run with a `/` or `+` (the callers check the shape)
 * is an AWS secret access key rather than a path: at least a quarter of its
 * letters are uppercase. Unlike `isSecretRun`, it needs no digit, so a key
 * without one is caught; a path such as
 * `/app/data/uploads/tenants/avatars/photo1` is almost all lowercase.
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
 */
function isSecretRun(run: string): boolean {
  if (!run.includes('/')) return !IDENTIFIER_RUN_PATTERN.test(run)
  const letters = run.replaceAll(/[^A-Za-z]/g, '')
  const uppercase = run.replaceAll(/[^A-Z]/g, '')
  return uppercase.length >= letters.length * BASE64_UPPERCASE_SHARE && /\d/.test(run)
}

/**
 * `BASE64_RUN_PATTERN`, matching only at `lastIndex`.
 */
const BASE64_RUN_AT = new RegExp(BASE64_RUN_PATTERN.source, 'y')

/**
 * Whether an AWS-key-shaped match followed by a `/` starts a longer run that
 * the base64 run rule replaces whole (`isSecretRun`). After the hex rule the
 * AWS rule leaves such a match to that rule, which runs next on the same
 * text, so the run is never split and its tail never left too short for it.
 * @param match - A match of `AWS_SECRET_KEY_PATTERN` on the view.
 * @returns True when the base64 run rule takes the match and what follows it.
 */
function isInLongerSecretRun(match: RegExpExecArray): boolean {
  BASE64_RUN_AT.lastIndex = match.index
  const run = BASE64_RUN_AT.exec(match.input)?.[0] ?? ''
  return run.length > AWS_SECRET_KEY_LENGTH && isSecretRun(run)
}

/**
 * Whether a run of base64 characters with a `/` that is part of an email
 * address is a secret: at least 40 characters, and an AWS secret access key
 * (`isAwsSecretKey`, exactly 40 characters of standard base64) or a run
 * `isSecretRun` calls a secret.
 * @param run - For `SLASHED_SECRET_EMAIL_PATTERN`, the run up to the `/`
 *   before the local part, then the local part's leading base64 characters;
 *   for `ADDRESS_SECRET_DOMAIN_PATTERN`, the domain.
 * @returns True when the run and the address are replaced together.
 */
function isSlashedSecret(run: string): boolean {
  if (run.length < SECRET_RUN_MIN) return false
  const isAwsShaped = run.length === AWS_SECRET_KEY_LENGTH && STANDARD_BASE64_PATTERN.test(run)
  return (isAwsShaped && isAwsSecretKey(run)) || isSecretRun(run)
}

/**
 * The text the rules scan: at most `SCAN_MAX` characters, and when cut,
 * only up to the last whitespace before the cut, so the scan never ends
 * inside a word, where a cut secret could be too short for its rule. A cut
 * text with no whitespace in its first `SCAN_MAX` characters is dropped whole.
 */
function scanned(value: string): string {
  if (value.length <= SCAN_MAX) return value
  let end = SCAN_MAX
  while (end > 0 && !/\s/.test(value.charAt(end - 1))) end -= 1
  return value.slice(0, end)
}

/**
 * Cut a text to `SCRUB_VALUE_MAX` characters, the marker included.
 * @param value - The scrubbed text.
 * @param wasCut - Whether `scanned` dropped part of the input or of a text a
 *   pass wrote.
 * @returns The text, ending in `…[truncated]` when anything was dropped.
 */
function capped(value: string, wasCut: boolean): string {
  if (!wasCut && value.length <= SCRUB_VALUE_MAX) return value
  const kept = value.slice(0, SCRUB_VALUE_MAX - TRUNCATION_MARKER.length)
  return `${kept}${TRUNCATION_MARKER}`
}

/**
 * The text being scrubbed, with the original span each character stands for.
 */
interface View {
  /**
   * The text, placeholders included.
   */
  text: string
  /**
   * For each character, where in the original text its span starts.
   */
  from: number[]
  /**
   * For each character, where in the original text its span ends.
   */
  to: number[]
  /**
   * For each character, the replacement it belongs to, or -1 for an original character.
   */
  token: number[]
}

/**
 * One replacement in a view: the characters from `start` to `end` become `text`.
 */
interface Edit {
  start: number
  end: number
  text: string
}

/**
 * The view of an original text, every character standing for itself.
 */
function originalView(input: string): View {
  const view: View = { text: input, from: [], to: [], token: [] }
  for (let at = 0; at < input.length; at += 1) {
    view.from.push(at)
    view.to.push(at + 1)
    view.token.push(-1)
  }
  return view
}

/**
 * Apply edits that do not overlap, in order, as `String.replaceAll` would.
 * The characters of an edit's text stand for the whole original span of the
 * characters it replaced; an empty edit stands for an empty span.
 * @param view - The view.
 * @param edits - The edits, sorted by start.
 * @param firstToken - The id the first edit's characters get.
 * @returns The view with the edits applied.
 */
function applyEdits(view: View, edits: readonly Edit[], firstToken: number): View {
  const next: View = { text: '', from: [], to: [], token: [] }
  /**
   * Copy one character of `view` into `next` with its span and replacement id.
   * @param at - Its index in `view`.
   */
  const keep = (at: number): void => {
    next.text += view.text.charAt(at)
    next.from.push(view.from[at] ?? 0)
    next.to.push(view.to[at] ?? 0)
    next.token.push(view.token[at] ?? -1)
  }
  let at = 0
  for (const [index, edit] of edits.entries()) {
    for (; at < edit.start; at += 1) keep(at)
    const start =
      edit.end > edit.start
        ? (view.from[edit.start] ?? 0)
        : (view.from[edit.start] ?? view.to.at(-1) ?? 0)
    let end = start
    for (let inner = edit.start; inner < edit.end; inner += 1)
      end = Math.max(end, view.to[inner] ?? 0)
    next.text += edit.text
    for (let character = 0; character < edit.text.length; character += 1) {
      next.from.push(start)
      next.to.push(end)
      next.token.push(firstToken + index)
    }
    at = edit.end
  }
  for (; at < view.text.length; at += 1) keep(at)
  return next
}

/**
 * The state of one scrub: the original text, its current view and the
 * next replacement id.
 */
interface Scrub {
  input: string
  view: View
  nextToken: number
}

/**
 * Apply edits found on the current view.
 * @param scrub - The scrub.
 * @param edits - The edits, in any order, none overlapping.
 */
function commit(scrub: Scrub, edits: Edit[]): void {
  if (edits.length === 0) return
  edits.sort((first, second) => first.start - second.start)
  scrub.view = applyEdits(scrub.view, edits, scrub.nextToken)
  scrub.nextToken += edits.length
}

/**
 * The part of a match a rule replaces: from `offset` into the match to its
 * end, with `text`; or nothing when the rule keeps the match.
 */
type Replacement = { offset: number; text: string } | undefined

/**
 * Apply one rule to the view: every match found on the same view, left to
 * right, replaced at once.
 * @param scrub - The scrub.
 * @param pattern - The rule, with the `g` flag.
 * @param replace - The part of a match to replace and its text.
 */
function apply(
  scrub: Scrub,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => Replacement
): void {
  const edits: Edit[] = []
  for (const match of scrub.view.text.matchAll(pattern)) {
    const replacement = replace(match)
    if (replacement !== undefined) {
      edits.push({
        start: match.index + replacement.offset,
        end: match.index + match[0].length,
        text: replacement.text,
      })
    }
  }
  commit(scrub, edits)
}

/**
 * The replacer for a rule that replaces the whole match with `text`.
 */
function whole(text: string): () => Replacement {
  return () => ({ offset: 0, text })
}

/**
 * The replacer for a rule that keeps its first group and replaces the rest
 * of the match with `text`.
 */
function afterGroup(text: string): (match: RegExpExecArray) => Replacement {
  return (match) => ({ offset: (match[1] ?? '').length, text })
}

/**
 * Apply a key rule (`AUTH_HEADER_PATTERN`, `KV_SECRET_PATTERN` or
 * `CODE_KEY_PATTERN`, whose group 1 is the kept key, separator and scheme)
 * left to right, replacing each value with `[redacted]` up to `runThroughEnd`.
 * @param scrub - The scrub.
 * @param pattern - The key rule, with the `g` flag.
 * @param innerKeys - The sticky key rules `runThroughEnd` looks for later keys with.
 */
function redactRunningThrough(scrub: Scrub, pattern: RegExp, innerKeys: readonly RegExp[]): void {
  const { text } = scrub.view
  const edits: Edit[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const keyEnd = match.index + (match[1] ?? '').length
    const end = runThroughEnd(text, keyEnd, match.index + match[0].length, innerKeys)
    edits.push({ start: keyEnd, end, text: '[redacted]' })
    pattern.lastIndex = end
  }
  commit(scrub, edits)
}

/**
 * A character no query, fragment or path takes, which splits a text into
 * the words `rejoinQueries` looks at.
 */
const WORD_BREAK_PATTERN = /[\s"'<>]/

/**
 * A `[redacted]` or `[token]` placeholder (the path-token, Bearer, Basic and
 * key rules write them) followed in the same word by a `?` or `#`.
 */
const REDACTED_BEFORE_QUERY_PATTERN = /\[(?:redacted|token)\][^\s"'<>]*[?#]/

/**
 * The runs of characters between word breaks (`WORD_BREAK_PATTERN`).
 * @returns Each word's start and its end, exclusive.
 */
function words(text: string): [number, number][] {
  const found: [number, number][] = []
  let start = 0
  while (start < text.length) {
    while (start < text.length && WORD_BREAK_PATTERN.test(text.charAt(start))) start += 1
    let end = start
    while (end < text.length && !WORD_BREAK_PATTERN.test(text.charAt(end))) end += 1
    if (end > start) found.push([start, end])
    start = end
  }
  return found
}

/**
 * Apply the query and then the fragment rule again to each word in which a
 * value replaced with `[redacted]` or `[token]` stands before a `?` or `#`
 * (`/x/pwd=[a b]?q=1` is `/x/pwd=[redacted]?q=1` at this point): a space or
 * quote inside the value kept the path apart from its query, so the query
 * rule left the query, and a second scrub would take it. A replaced query
 * holds no word break, so each such word is the same word for both rules.
 */
function rejoinQueries(scrub: Scrub): void {
  if (!REDACTED_BEFORE_QUERY_PATTERN.test(scrub.view.text)) return
  const targets = new Set<number>()
  const queries: Edit[] = []
  for (const [index, [start, end]] of words(scrub.view.text).entries()) {
    const word = scrub.view.text.slice(start, end)
    if (!REDACTED_BEFORE_QUERY_PATTERN.test(word)) continue
    targets.add(index)
    for (const match of word.matchAll(QUERY_PATTERN)) {
      queries.push({
        start: start + match.index + (match[1] ?? '').length,
        end: start + match.index + match[0].length,
        text: '?[query]',
      })
    }
  }
  commit(scrub, queries)
  const fragments: Edit[] = []
  for (const [index, [start, end]] of words(scrub.view.text).entries()) {
    if (!targets.has(index)) continue
    for (const match of scrub.view.text.slice(start, end).matchAll(FRAGMENT_PATTERN)) {
      if (isHarmlessFragment(match[2] ?? '')) continue
      fragments.push({
        start: start + match.index + (match[1] ?? '').length,
        end: start + match.index + match[0].length,
        text: '#[fragment]',
      })
    }
  }
  commit(scrub, fragments)
}

/**
 * A secret-named key and its separator only, at `lastIndex`.
 */
const KV_SECRET_KEY_AT = new RegExp(KV_SECRET_KEY, 'iy')

/**
 * `KV_SECRET_VALUE`, at `lastIndex`.
 */
const KV_SECRET_VALUE_AT = new RegExp(KV_SECRET_VALUE, 'iy')

/**
 * How many characters of the original text before a replacement's end a key
 * that runs out of it may start, which bounds the search; a key that starts
 * further back is not found.
 */
const TOKEN_KEY_REACH = 80

/**
 * The original spans of values whose secret-named key an earlier rule
 * swallowed into a placeholder: a key that starts inside a replacement's original text and
 * ends at or after its end (`/reset/x.tsrefresh_token = …`,
 * `?a=1/api_key="…"`), read on the original text, with its value read on the
 * view right after the placeholder and run through later keys. The key's
 * tail past the placeholder must be original text no rule replaced.
 * @param scrub - The scrub, after the key rules.
 * @param innerKeys - The sticky key rules `runThroughEnd` looks for later keys with.
 * @returns The original spans to redact once every other rule has run.
 */
function tokenKeyRanges(scrub: Scrub, innerKeys: readonly RegExp[]): [number, number][] {
  const { view } = scrub
  const ranges: [number, number][] = []
  let at = 0
  while (at < view.token.length) {
    const id = view.token[at] ?? -1
    let end = at + 1
    while (end < view.token.length && view.token[end] === id) end += 1
    if (id !== -1) {
      const range = tokenKeyRange(scrub, at, end, innerKeys)
      if (range !== undefined) ranges.push(range)
    }
    at = end
  }
  return ranges
}

/**
 * The original span of the value of a key that runs out of one replacement;
 * the key's tail past the placeholder must be original text no rule replaced
 * (it ends at or before `keptUntil`: the next replacement's start, or the
 * input's end when there is none).
 * @param scrub - The scrub.
 * @param tokenStart - Where the replacement starts in the view.
 * @param tokenEnd - Where it ends in the view.
 * @param innerKeys - The sticky key rules `runThroughEnd` looks for later keys with.
 * @returns The span, or undefined when no key runs out of it.
 */
function tokenKeyRange(
  scrub: Scrub,
  tokenStart: number,
  tokenEnd: number,
  innerKeys: readonly RegExp[]
): [number, number] | undefined {
  const { input, view } = scrub
  const originalStart = view.from[tokenStart] ?? 0
  const originalEnd = view.to[tokenStart] ?? 0
  let keptUntil = input.length
  for (let at = tokenEnd; at < view.token.length; at += 1) {
    if (view.token[at] !== -1) {
      keptUntil = view.from[at] ?? input.length
      break
    }
  }
  for (let at = Math.max(originalStart, originalEnd - TOKEN_KEY_REACH); at < originalEnd; at += 1) {
    KV_SECRET_KEY_AT.lastIndex = at
    const key = KV_SECRET_KEY_AT.exec(input)
    if (key === null) continue
    const keyEnd = at + key[0].length
    if (keyEnd < originalEnd || keyEnd > keptUntil) continue
    const valueAt = tokenEnd + (keyEnd - originalEnd)
    KV_SECRET_VALUE_AT.lastIndex = valueAt
    const value = KV_SECRET_VALUE_AT.exec(view.text)
    if (value === null || value[0].length === 0) continue
    const end = runThroughEnd(view.text, valueAt, valueAt + value[0].length, innerKeys)
    return [view.from[valueAt] ?? 0, view.to[end - 1] ?? 0]
  }
  return undefined
}

/**
 * A placeholder and nothing else.
 */
const LONE_PLACEHOLDER_PATTERN = new RegExp(`^${PLACEHOLDER}$`)

/**
 * Replace every run of view characters that stands for part of one of
 * `ranges` with `[redacted]`, except a run that is one placeholder a rule
 * already wrote, which stays.
 * @param scrub - The scrub.
 * @param ranges - Original spans.
 */
function redactRanges(scrub: Scrub, ranges: readonly [number, number][]): void {
  const { view } = scrub
  /**
   * Whether a view character's original span overlaps one of `ranges`.
   * @param at - Its index in the view.
   * @returns True when the character is part of a value to redact.
   */
  const isCovered = (at: number): boolean =>
    ranges.some(([start, end]) => (view.from[at] ?? 0) < end && (view.to[at] ?? 0) > start)
  const edits: Edit[] = []
  let at = 0
  while (at < view.text.length) {
    if (!isCovered(at)) {
      at += 1
      continue
    }
    let end = at
    while (end < view.text.length && isCovered(end)) end += 1
    const run = view.text.slice(at, end)
    const isOneToken = view.token[at] !== -1 && view.token[at] === view.token[end - 1]
    if (!(isOneToken && LONE_PLACEHOLDER_PATTERN.test(run)))
      edits.push({ start: at, end, text: '[redacted]' })
    at = end
  }
  commit(scrub, edits)
}

/**
 * Every rule once, in order, then the values of keys found inside
 * replacements.
 * @param input - The scanned text (`scanned`) of the input or of the text
 *   the previous pass wrote.
 * @returns The scrubbed text, and whether a key inside a replacement was found.
 */
function scrubOnce(input: string): { text: string; keyInToken: boolean } {
  const scrub: Scrub = { input, view: originalView(input), nextToken: 0 }
  apply(scrub, KEY_DETAIL_PATTERN, (match) => ({
    offset: `Key (${match[1] ?? ''})=(`.length,
    text: '[value])',
  }))
  apply(scrub, PG_INPUT_PATTERN, afterGroup('"[value]"'))
  apply(scrub, PG_RANGE_PATTERN, afterGroup('"[value]"'))
  apply(scrub, JSON_SNIPPET_PATTERN, afterGroup('"[value]" is not valid JSON'))
  apply(scrub, USERINFO_PATTERN, afterGroup('[credentials]@'))
  apply(scrub, QUERY_PATTERN, afterGroup('?[query]'))
  apply(scrub, FRAGMENT_PATTERN, (match) =>
    isHarmlessFragment(match[2] ?? '')
      ? undefined
      : { offset: (match[1] ?? '').length, text: '#[fragment]' }
  )
  apply(scrub, PATH_TOKEN_PATTERN, afterGroup('[token]'))
  apply(scrub, BEARER_PATTERN, whole('Bearer [token]'))
  apply(scrub, BASIC_PATTERN, afterGroup(' [token]'))
  const hasOauthContext = OAUTH_CONTEXT_PATTERN.test(input)
  const innerKeys = hasOauthContext
    ? [KV_SECRET_AT, AUTH_HEADER_AT, CODE_KEY_AT]
    : [KV_SECRET_AT, AUTH_HEADER_AT]
  redactRunningThrough(scrub, AUTH_HEADER_PATTERN, innerKeys)
  redactRunningThrough(scrub, KV_SECRET_PATTERN, innerKeys)
  if (hasOauthContext)
    redactRunningThrough(scrub, CODE_KEY_PATTERN, [...innerKeys, SCHEMED_VALUE_AT])
  const keyRanges = tokenKeyRanges(scrub, innerKeys)
  rejoinQueries(scrub)
  apply(scrub, JWT_PATTERN, whole('[jwt]'))
  apply(scrub, SLASHED_SECRET_EMAIL_PATTERN, (match) =>
    isSlashedSecret(`${match[1] ?? ''}${LEADING_BASE64_PATTERN.exec(match[2] ?? '')?.[0] ?? ''}`)
      ? { offset: 0, text: '[email]' }
      : undefined
  )
  apply(scrub, ADDRESS_SECRET_DOMAIN_PATTERN, (match) =>
    isSlashedSecret(match[1] ?? '') ? { offset: 0, text: '[email]' } : undefined
  )
  apply(scrub, EMAIL_PATTERN, whole('[email]'))
  applyKeyShapes(scrub, false)
  apply(scrub, IPV4_PATTERN, whole('[ip]'))
  apply(scrub, IPV6_PATTERN, whole('[ip]'))
  apply(scrub, PHONE_PATTERN, whole('[phone]'))
  apply(scrub, HEX_RUN_PATTERN, whole('[secret]'))
  applyKeyShapes(scrub, true)
  apply(scrub, BASE64_RUN_PATTERN, (match) =>
    isSecretRun(match[0]) ? { offset: 0, text: '[secret]' } : undefined
  )
  apply(scrub, IPV6_HEAD_PATTERN, whole('[ip]'))
  apply(scrub, EMAIL_QUERY_PATTERN, afterGroup('?[query]'))
  apply(scrub, SCHEME_TAIL_PATTERN, (match) => {
    // The replacement starts at the first separator, so whitespace or a line break before it is kept.
    const pairs = match[2] ?? ''
    const at = Math.max(0, pairs.search(/[,;]/))
    return { offset: (match[1] ?? '').length + at, text: `${pairs.charAt(at)}[redacted]` }
  })
  redactRanges(scrub, keyRanges)
  return { text: scrub.view.text, keyInToken: keyRanges.length > 0 }
}

/**
 * The PostHog-key, vendor-credential and AWS secret access key rules, which
 * run once before the IP, phone and hex rules and once after the hex rule.
 * Before the hex rule, an AWS-shaped match that a `/` follows is left alone:
 * a hex run after the `/` can still change how the run reads. After it, such
 * a match is left to the base64 run rule when that rule replaces the whole
 * run (`isInLongerSecretRun`), which then reads the same text; and the AWS
 * rule runs twice, so a key straight after one it replaced is found too.
 * @param scrub - The scrub.
 * @param isAfterHex - Whether the hex rule has run.
 */
function applyKeyShapes(scrub: Scrub, isAfterHex: boolean): void {
  apply(scrub, POSTHOG_KEY_PATTERN, whole('[posthog-key]'))
  apply(scrub, VENDOR_KEY_PATTERN, whole('[secret]'))
  /**
   * The AWS rule's replacer.
   * @param match - A match of `AWS_SECRET_KEY_PATTERN`.
   * @returns `[secret]` for a key this call replaces, else nothing.
   */
  const awsKey = (match: RegExpExecArray): Replacement => {
    if (!isAwsSecretKey(match[0])) return undefined
    const isBeforeSlash = match.input.charAt(match.index + match[0].length) === '/'
    const isLeft = isAfterHex ? isInLongerSecretRun(match) : isBeforeSlash
    return isLeft ? undefined : { offset: 0, text: '[secret]' }
  }
  apply(scrub, AWS_SECRET_KEY_PATTERN, awsKey)
  if (isAfterHex) apply(scrub, AWS_SECRET_KEY_PATTERN, awsKey)
}

/**
 * The most times the rules run over a text in whose first pass a key inside
 * a replacement was found; each run after the first scrubs the text the last
 * one wrote, and they stop at the first run that leaves it unchanged.
 */
const PASSES_MAX = 3

/**
 * Remove personal data and secrets from one text. The rules run in this
 * order:
 * 1. Postgres echoes: a `Key (col)=(value)` detail keeps the columns and
 *    loses the value (`([value])`); the value after `invalid input syntax for
 *    type`, `invalid input value for enum`, `malformed … literal:` or
 *    `date/time field value out of range:`, the quoted value in `value "n" is
 *    out of range for type`, and the snippet in a V8 `is not valid JSON`
 *    error become `"[value]"`.
 * 2. A URL's userinfo becomes `[credentials]@`; the query string of a URL, a
 *    path, or a bare word whose query holds an `=`, becomes `?[query]`; a
 *    URL's or path's fragment, unless `isHarmlessFragment` keeps it, becomes
 *    `#[fragment]`; the segment after `/reset/`, `/verify/`, `/invite/` or
 *    `/accept/` becomes `[token]`.
 * 3. `Bearer <credential>` becomes `Bearer [token]`, in that letter case;
 *    `Basic <base64>` becomes `Basic [token]`, the scheme's case kept.
 * 4. The value of an Authorization or Cookie key (`AUTH_HEADER_PATTERN`), of
 *    a secret-named key (`KV_SECRET_PATTERN`) and, in a text that names an
 *    OAuth exchange (`OAUTH_CONTEXT_PATTERN`), of every `code` key becomes
 *    `[redacted]`, except a value `KEPT_VALUE` keeps and an Authorization
 *    value step 3 already replaced (`AUTH_HEADER_PATTERN`). A value that takes a
 *    later such key runs on to the end of that key's value
 *    (`redactRunningThrough`). A query or fragment that a replaced value
 *    joins to its path is then replaced as in step 2 (`rejoinQueries`).
 * 5. A JWT becomes `[jwt]`; an email address (`EMAIL_PATTERN`) becomes
 *    `[email]`, together with a secret-looking base64 run joined to its local
 *    part by `/` (`SLASHED_SECRET_EMAIL_PATTERN`) or forming its domain
 *    (`ADDRESS_SECRET_DOMAIN_PATTERN`). This runs before the PostHog-key and
 *    vendor-credential rules, so an address whose local part looks like one
 *    of those keys goes whole, domain included.
 * 6. A PostHog key becomes `[posthog-key]` and a vendor credential
 *    (`VENDOR_KEY_PATTERN`) or AWS secret access key `[secret]`; an IPv4 or
 *    IPv6 address becomes `[ip]` and an international phone number `[phone]`;
 *    a run of 32 or more hex digits becomes `[secret]`, and the PostHog,
 *    vendor and AWS rules run again for a key glued to it; a run of 40 or
 *    more base64 characters that `isSecretRun` accepts becomes `[secret]`,
 *    and the head of an IPv6 address whose last group went into a `[secret]`
 *    or `[email]` becomes `[ip]` (`IPV6_HEAD_PATTERN`). A
 *    UUID on its own matches none of these and is kept. Then the query of a
 *    URL whose path is addresses (`mailto:[email]?subject=…`), or straight
 *    after `mailto:`, becomes `?[query]` (`EMAIL_QUERY_PATTERN`). Last, any
 *    `,key=value` or `;key=value` pairs, quoted values included, still glued
 *    to a `Bearer [token]` or `Basic [token]` become `[redacted]` after the
 *    first separator (`SCHEME_TAIL_PATTERN`), while prose after a comma is
 *    kept.
 * 7. The value of a secret-named key that an earlier rule took into its
 *    placeholder, found again in the original text (`tokenKeyRanges`),
 *    becomes `[redacted]`. When there is one, the rules run again over the
 *    result, at most `PASSES_MAX` times in all.
 * 8. The result is cut to `SCRUB_VALUE_MAX` characters, ending in
 *    `…[truncated]`; every pass scans only the first `SCAN_MAX` characters
 *    of its input (`scanned`), the later passes included, since a pass can
 *    lengthen the text.
 *
 * A key-named word is replaced even in prose (`Missing token: please log in`
 * becomes `Missing token: [redacted]`): the rule gives up some readable text
 * rather than risk keeping a value. Applying it to its own output gives the
 * same text for every row of the vector file and for a placeholder in a URL
 * fragment (`isHarmlessFragment`). The second application can change a
 * result the length cap cut inside a key's value or a placeholder, and
 * contrived inputs that glue a phone number, IP address or hex run to one
 * another, put an address with a quoted local part (`"jane doe"@…`) straight
 * against a URL's or path's query or fragment, end an address with a `.`
 * straight before a query (`jane@example.com.?a=1`), or leave a placeholder
 * in quotes straight before an `@` (a placeholder written by the first pass
 * can open a match for the second, a replaced quoted address does not stop
 * a path, and a later rule can shorten a quoted span under the 64-character
 * quoted local-part limit, as the scheme-tail rule does before a `%40`).
 * @param value - Text bound for a third party, such as an exception's type or
 *   value, a stack frame's filename or function, or a log line.
 * @returns The scrubbed text, at most `SCRUB_VALUE_MAX` characters.
 */
export function scrubText(value: string): string {
  const input = scanned(value)
  let pass = scrubOnce(input)
  let wasCut = input.length < value.length
  if (pass.keyInToken) {
    for (let count = 1; count < PASSES_MAX; count += 1) {
      // A pass can lengthen the text (`token=a` becomes `token=[redacted]`), so each pass's input is cut to SCAN_MAX again.
      const rescanned = scanned(pass.text)
      wasCut ||= rescanned.length < pass.text.length
      const next = scrubOnce(rescanned)
      if (next.text === pass.text) break
      pass = next
    }
  }
  return capped(pass.text, wasCut)
}
