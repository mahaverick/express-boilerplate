// src/validators/safe-text.validators.ts
//
// A free-text field this app stores and later renders (a tenant's name,
// logo URL, website, description; a person's first/last name) must not be
// able to carry a Unicode control character or a bidi override/isolate —
// both are invisible-or-misleading in a browser and neither is legitimate
// in any of these fields. Not every string field gets this: a search
// query, an opaque cursor, or a token is never rendered back verbatim the
// way these are, so each call site opts in individually.
//
// On the regex shape: a literal control-character escape or range (e.g.
// `/[\u0000-\u001F]/`) trips `no-control-regex`. `/\p{Cc}/u`, the Unicode
// property escape for the same character set (U+0000-U+001F and
// U+007F-U+009F), does not — but it also matches `\n`/`\t`, which a
// multiline field must allow. Excluding them from the same character class
// needs the regex `v` flag's set subtraction, which this project's
// TypeScript target does not support, so a copy of the string has
// `\n`/`\t` stripped before the control-character test instead.
const FORBIDDEN_CONTROL = /\p{Cc}/u
const BIDI_OVERRIDE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u
const MULTILINE_ALLOWED = /[\n\t]/g

/**
 * Build a predicate that rejects Unicode `Cc` control characters and bidi
 * override/isolate characters, for use with zod's `.refine()`.
 * @param options - Configures which control characters are allowed.
 * @param options.multiline - `true` allows `\n` and `\t` (still rejecting
 *   every other control character, including a bare `\r`); omit or set
 *   `false` for a single-line field, which allows neither.
 * @returns A predicate: `true` when `value` contains none of the above.
 */
export function safeText(options: { multiline?: boolean } = {}): (value: string) => boolean {
  return (value: string): boolean => {
    const withoutAllowedWhitespace = options.multiline
      ? value.replaceAll(MULTILINE_ALLOWED, '')
      : value
    return !FORBIDDEN_CONTROL.test(withoutAllowedWhitespace) && !BIDI_OVERRIDE.test(value)
  }
}

/**
 * Normalise `\r\n` to `\n` before validation, for a multiline field. A
 * lone `\r` that survives this (not part of a `\r\n` pair) is left for
 * `safeText({ multiline: true })` to reject as a control character.
 * @param value - The raw input zod is about to parse; anything but a
 *   string passes through untouched, for zod's own type check to reject.
 * @returns The normalised string, or `value` unchanged when it isn't one.
 */
export function normalizeMultilineText(value: unknown): unknown {
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value
}
