/**
 * @file Patterns for prose that narrates how the code got here instead of
 * stating what is true now. Shared by the comment-style ESLint rule and lint:docs.
 */

/**
 * Words and phrases that narrate history (case-insensitive). A handler
 * previously passed to a function, or a name previously registered under a
 * key, is an earlier step of the same runtime flow: the lookahead lets a
 * participle plus preposition through, across a JSDoc line break's `*`.
 */
export const HISTORY_WORDS =
  /\b(?:task|stream|lane|wave)[ -]\d+[a-z]?\b|\btask-\d+-[\w-]+\.md\b|\bbefore this fix\b|\ba later (?:task|stream|wave|pr)\b|\bpreviously\b(?![\s*]+(?:\w+(?:ed|en)|sent|set)[\s*]+(?:to|under|by|with|in|into|for|from|on|at)\b)/i

/**
 * Audit and ledger ids: prefixes H, M, E, X, R or NF directly followed by
 * digits, or P/C followed by a hyphen and digits (case-sensitive).
 */
export const HISTORY_IDS = /\b(?:NF|H|M|E|X|R)\d{1,2}[a-z]?\b|\b[PC]-\d{1,2}\b|\bE-[TW]\b/

/**
 * Find the first history phrase in a piece of prose.
 * @param text - A comment body or a line of markdown.
 * @returns The matched phrase, or null when the text states only current facts.
 */
export function findHistory(text) {
  const match = HISTORY_WORDS.exec(text) ?? HISTORY_IDS.exec(text)
  return match ? match[0] : null
}
