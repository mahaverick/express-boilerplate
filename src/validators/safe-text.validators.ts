/**
 * @file `safeText`, the refinement for free-text fields this app stores and
 * later renders (tenant name, logo URL, website, description; a person's
 * names): no Unicode control characters and no bidi override or isolate, both
 * invisible or misleading in a browser. A search query, cursor or token is
 * never rendered back, so each field opts in.
 */

/**
 * Unicode `Cc` (U+0000-U+001F, U+007F-U+009F), written as a property escape
 * because a literal range trips `no-control-regex`. It also matches `\n` and
 * `\t`; excluding them in the class needs the `v` flag, which this project's
 * TypeScript target lacks, so a multiline value has them stripped before the
 * test instead.
 */
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
