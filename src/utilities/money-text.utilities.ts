/**
 * @file The formatter for an amount in copy: a billing email, a
 * notification or a staff alert. Amounts are stored in paise and read in
 * rupees.
 */

/**
 * An amount in paise as rupees, grouped the Indian way, without the sign.
 * @param amountMinor - The amount in paise.
 * @returns For example "999", "9,990" or "1,49,999.50".
 */
export function formatRupees(amountMinor: number): string {
  const hasPaise = amountMinor % 100 !== 0
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}
