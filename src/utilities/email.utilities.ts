// src/utilities/email.utilities.ts
//
// Email address helpers shared by auto-join and the audit log, which
// records a domain, never a full address.

/**
 * The domain of an email address: everything after the last `@`, lowercased.
 * @param email - The address.
 * @returns The domain, or undefined when the address has no `@` or nothing follows it.
 */
export function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@')
  if (at === -1) return undefined
  const domain = email.slice(at + 1).toLowerCase()
  return domain.length > 0 ? domain : undefined
}
