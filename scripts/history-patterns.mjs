/**
 * @file Patterns for prose that narrates how the code got here instead of
 * stating present facts. The comment-style ESLint rule and lint:docs both
 * call `findHistory`.
 */

/**
 * Words and phrases that narrate history (case-insensitive). A handler
 * previously passed to a function, a name previously registered under a key
 * and a token previously issued to a session are earlier steps of the same
 * runtime flow: the lookahead lets exactly those three phrases through, across
 * a JSDoc line break's `*`.
 */
const HISTORY_WORDS =
  /\b(?:task|stream|lane|wave)[ -]\d+[a-z]?\b|\btask-\d+-[\w-]+\.md\b|\bbefore this fix\b|\ba later (?:task|stream|wave|pr)\b|\bpreviously\b(?![\s*]+(?:passed[\s*]+to|registered[\s*]+under|issued[\s*]+to)\b)/i

/**
 * Audit, ruling and sub-project ids (case-sensitive): prefixes H, M, E, X, R
 * or NF directly followed by digits and an optional letter; I directly
 * followed by digits only, so a word such as I18n passes; P/C followed by a
 * hyphen and digits; E followed by a hyphen and T or W; and SP followed by a
 * digit, an optional letter a to e, and an optional hyphen and digit.
 */
const HISTORY_IDS =
  /\b(?:NF|H|M|E|X|R)\d{1,2}[a-z]?\b|\bI\d{1,2}\b|\bSP\d[a-e]?(?:-\d)?\b|\b[PC]-\d{1,2}\b|\bE-[TW]\b/

/**
 * The history phrase a piece of prose holds: the first `HISTORY_WORDS`
 * match, and only when there is none, the first `HISTORY_IDS` match.
 * @param text - A comment body or a line of markdown.
 * @returns The matched phrase, or null when neither pattern matches.
 */
export function findHistory(text) {
  const match = HISTORY_WORDS.exec(text) ?? HISTORY_IDS.exec(text)
  return match ? match[0] : null
}
