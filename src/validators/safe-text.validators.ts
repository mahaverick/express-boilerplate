/**
 * @file `safeText`, the refinement for free-text fields this app stores and
 * later renders (tenant name, logo URL, website, description; a person's
 * names): no Unicode control characters, no format characters (bidi marks,
 * overrides and isolates, zero-width spaces, the word joiner, the byte order
 * mark) and no line or paragraph separator, all invisible or misleading in a
 * browser. The two joiners some scripts and emoji need are allowed inside a
 * word or emoji sequence only. A search query, cursor or token is never
 * rendered back, so each field opts in.
 */

/**
 * Unicode `Cc` (U+0000-U+001F, U+007F-U+009F), written as a property escape
 * because a literal range trips `no-control-regex`. It also matches `\n` and
 * `\t`; excluding them in the class needs the `v` flag, which this project's
 * TypeScript target lacks, so a multiline value has them stripped before the
 * test instead.
 */
const FORBIDDEN_CONTROL = /\p{Cc}/u
/**
 * Unicode `Cf` (every bidi mark, override and isolate, U+200B-U+200D, U+2060,
 * U+FEFF, U+061C, the soft hyphen and the emoji tag characters) plus U+2028
 * and U+2029 (`Zl`/`Zp`). A lookalike name differs from the real one only by
 * one of these, so a direction mark inside a name is refused too.
 */
const INVISIBLE_FORMAT = /[\p{Cf}\u{2028}\u{2029}]/u
/**
 * The joiners real text needs, removed before the `Cf` test: U+200C (ZWNJ,
 * Persian and Indic words) between two letters or marks, and U+200D (ZWJ,
 * Indic conjuncts and emoji sequences) after a letter, mark, pictograph or
 * skin-tone modifier and before a letter, mark or pictograph. U+FE0F, the
 * emoji presentation selector, is a mark (`Mn`). A joiner at either end,
 * beside a space or punctuation, or beside another joiner stays refused.
 */
const IN_WORD_JOINER =
  /(?<=[\p{L}\p{M}])\u{200C}(?=[\p{L}\p{M}])|(?<=[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}])\u{200D}(?=[\p{L}\p{M}\p{Extended_Pictographic}])/gu
const MULTILINE_ALLOWED = /[\n\t]/g

/**
 * Build a predicate that rejects Unicode `Cc` control characters, `Cf` format
 * characters (except a joiner inside a word or emoji sequence) and the line
 * and paragraph separators, for use with zod's `.refine()`.
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
    return (
      !FORBIDDEN_CONTROL.test(withoutAllowedWhitespace) &&
      !INVISIBLE_FORMAT.test(value.replaceAll(IN_WORD_JOINER, ''))
    )
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
