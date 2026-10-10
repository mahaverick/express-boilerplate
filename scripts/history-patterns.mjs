/**
 * @file Patterns for prose that narrates how the code got here instead of
 * stating what is true now. Shared by the comment-style ESLint rule and lint:docs.
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
 * Audit and ledger ids: prefixes H, M, E, X, R or NF directly followed by
 * digits, or P/C followed by a hyphen and digits (case-sensitive).
 */
const HISTORY_IDS = /\b(?:NF|H|M|E|X|R)\d{1,2}[a-z]?\b|\b[PC]-\d{1,2}\b|\bE-[TW]\b/

/**
 * Find the first history phrase in a piece of prose.
 * @param text - A comment body or a line of markdown.
 * @returns The matched phrase, or null when the text states only current facts.
 */
export function findHistory(text) {
  const match = HISTORY_WORDS.exec(text) ?? HISTORY_IDS.exec(text)
  return match ? match[0] : null
}
