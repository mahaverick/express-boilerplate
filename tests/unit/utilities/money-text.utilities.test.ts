import { describe, expect, it } from 'vite-plus/test'
import { formatRupees } from '@/utilities/money-text.utilities'

describe('formatRupees', () => {
  it.each([
    [99_900, '999'],
    [999_000, '9,990'],
    [14_999_950, '1,49,999.50'],
    [100, '1'],
  ])('reads %i paise as %s', (amountMinor, text) => {
    expect(formatRupees(amountMinor)).toBe(text)
  })
})
