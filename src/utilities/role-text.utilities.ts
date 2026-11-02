/**
 * @file A membership role as a sentence reads it, with its article: "as a
 * member", "as an admin", "as an owner".
 */

/**
 * A role with "a" or "an" before it, by its first letter.
 * @param role - The role, such as `member` or `admin`.
 * @returns For example "a member" or "an admin".
 */
export function roleWithArticle(role: string): string {
  return `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`
}
