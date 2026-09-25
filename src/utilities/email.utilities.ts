// src/utilities/email.utilities.ts
//
// Email address helpers shared by auto-join, the invite validator and the
// audit log, which records a domain, never a full address.

/**
 * A lowercase dotted hostname: labels of 1-63 letters, digits and inner
 * hyphens, at most 253 characters in all. The only domain shape the audit
 * log stores, and the one the invite validator requires.
 */
export const EMAIL_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/

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

/**
 * The domain of an email address when it is a lowercase dotted hostname
 * (`EMAIL_DOMAIN_PATTERN`).
 * @param email - The address.
 * @returns The lowercased domain, or undefined when there is none or it is not a hostname.
 */
export function hostnameDomain(email: string): string | undefined {
  const domain = emailDomain(email)
  return domain !== undefined && EMAIL_DOMAIN_PATTERN.test(domain) ? domain : undefined
}
