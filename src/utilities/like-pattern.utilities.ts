/**
 * @file LIKE-pattern escaping for the staff searches, shared by the
 * cross-tenant repositories (which may not import each other).
 */

/**
 * Escape LIKE's wildcards and its escape character, so a search text matches
 * literally. Pair it with `escape '\'` in the SQL.
 * @param value - The raw search text.
 * @returns The text with `\`, `%` and `_` escaped by a backslash.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll(/[%\\_]/g, String.raw`\$&`)
}
