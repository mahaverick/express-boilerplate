/** @file Table-driven tests for the pure GST rules. */
import { describe, expect, it } from 'vitest'
import {
  amountInWords,
  creditNoteAmounts,
  exportPeriodRange,
  financialYearEnd,
  financialYearEndYear,
  financialYearOf,
  formatDocumentNumber,
  gstinCheckCharacter,
  gstinProblem,
  isLateCreditNote,
  isLateInvoice,
  istDate,
  istMidnight,
  istTime,
  normaliseGstin,
  placeOfSupply,
  splitInclusive,
  stateOf,
  supplyKind,
  taxStatusOf,
} from '@/utilities/gst.utilities'

describe('gstin', () => {
  it.each([
    ['27AAPFU0939F1ZV', null],
    ['29ABCDE1234F1ZW', null],
    ['27ABCDE1234F1Z0', null],
    ['29ABCDE1234F1ZX', 'checksum'],
    ['25ABCDE1234F1Z4', 'state'],
    ['99ABCDE1234F1ZP', 'state'],
    ['29ABCDE1234F1Z', 'shape'],
    ['29ABCDE1234F0ZW', 'shape'],
  ])('gstinProblem(%s) is %s', (gstin, problem) => {
    expect(gstinProblem(gstin)).toBe(problem)
  })

  it('computes V for 27AAPFU0939F1Z', () => {
    expect(gstinCheckCharacter('27AAPFU0939F1Z')).toBe('V')
  })

  it('normalises case', () => {
    expect(gstinProblem(normaliseGstin(' 29abcde1234f1zw '))).toBeNull()
  })

  it('stateOf finds selectable codes only', () => {
    expect(stateOf('29')?.name).toBe('Karnataka')
    expect(stateOf('25')).toBeUndefined()
    expect(stateOf('28')).toBeUndefined()
    expect(stateOf('99')).toBeUndefined()
  })
})

describe('splitInclusive', () => {
  it('splits 99900 intra', () => {
    expect(splitInclusive(99_900, 'intra')).toEqual({
      totalMinor: 99_900,
      taxableMinor: 84_661,
      cgstMinor: 7619,
      sgstMinor: 7620,
      igstMinor: 0,
      ratePercent: 18,
    })
  })

  it('splits 99900 inter', () => {
    expect(splitInclusive(99_900, 'inter')).toMatchObject({
      taxableMinor: 84_661,
      igstMinor: 15_239,
      cgstMinor: 0,
      sgstMinor: 0,
    })
  })

  it('splits 999000 intra', () => {
    expect(splitInclusive(999_000, 'intra')).toMatchObject({
      taxableMinor: 846_610,
      cgstMinor: 76_195,
      sgstMinor: 76_195,
    })
  })

  it('every total from 1 to 200000 adds up and taxable is the rounded share', () => {
    const failures: number[] = []
    for (let total = 1; total <= 200_000; total++) {
      const a = splitInclusive(total, 'intra')
      const isSumOk = a.taxableMinor + a.cgstMinor + a.sgstMinor === total
      const isTaxableOk = a.taxableMinor === Math.round((total * 100) / 118)
      const isSplitOk = a.sgstMinor - a.cgstMinor === (total - a.taxableMinor) % 2
      if (!(isSumOk && isTaxableOk && isSplitOk)) failures.push(total)
    }
    expect(failures).toEqual([])
  })

  it('1 paisa has taxable 1 and no tax', () => {
    expect(splitInclusive(1, 'intra')).toMatchObject({
      taxableMinor: 1,
      cgstMinor: 0,
      sgstMinor: 0,
    })
  })
})

describe('creditNoteAmounts', () => {
  const inv = { ...splitInclusive(99_900, 'intra'), supply: 'intra' as const }

  it('adds 50000 then 49900 up to the invoice', () => {
    expect(creditNoteAmounts(inv, 0, 50_000)).toMatchObject({
      totalMinor: 50_000,
      taxableMinor: 42_373,
      cgstMinor: 3813,
      sgstMinor: 3814,
    })
    expect(creditNoteAmounts(inv, 50_000, 49_900)).toMatchObject({
      totalMinor: 49_900,
      taxableMinor: 42_288,
      cgstMinor: 3806,
      sgstMinor: 3806,
    })
  })

  it('a full refund equals the invoice', () => {
    expect(creditNoteAmounts(inv, 0, 99_900)).toMatchObject({
      taxableMinor: 84_661,
      cgstMinor: 7619,
      sgstMinor: 7620,
    })
  })

  it('49950 twice', () => {
    expect(creditNoteAmounts(inv, 0, 49_950)).toMatchObject({
      taxableMinor: 42_331,
      cgstMinor: 3809,
      sgstMinor: 3810,
    })
    expect(creditNoteAmounts(inv, 49_950, 49_950)).toMatchObject({
      taxableMinor: 42_330,
      cgstMinor: 3810,
      sgstMinor: 3810,
    })
  })

  it('an inter-state note carries igst only', () => {
    const interInv = { ...splitInclusive(99_900, 'inter'), supply: 'inter' as const }
    expect(creditNoteAmounts(interInv, 0, 99_900)).toMatchObject({
      igstMinor: 15_239,
      cgstMinor: 0,
      sgstMinor: 0,
    })
  })

  it('1 paisa has taxable 1 and no tax', () => {
    expect(creditNoteAmounts(inv, 0, 1)).toMatchObject({
      totalMinor: 1,
      taxableMinor: 1,
      cgstMinor: 0,
      sgstMinor: 0,
    })
  })

  it('does not lose precision at 1e7 x 1e7', () => {
    const big = { ...splitInclusive(10_000_000, 'intra'), supply: 'intra' as const }
    const note = creditNoteAmounts(big, 0, 10_000_000)
    expect(note.taxableMinor).toBe(big.taxableMinor)
    expect(note.cgstMinor).toBe(big.cgstMinor)
  })
})

describe('supply and place', () => {
  it('supplyKind compares state codes', () => {
    expect(supplyKind('29', '29')).toBe('intra')
    expect(supplyKind('29', '27')).toBe('inter')
  })

  it('place of supply: GSTIN state > billing state > seller state', () => {
    expect(placeOfSupply({ gstin: '27ABCDE1234F1Z0', stateCode: '29' }, '33')).toBe('27')
    expect(placeOfSupply({ gstin: null, stateCode: '29' }, '33')).toBe('29')
    expect(placeOfSupply({ gstin: null, stateCode: null }, '33')).toBe('33')
  })
})

describe('dates', () => {
  it.each([
    ['2027-03-31T18:29:59Z', '26-27'],
    ['2027-03-31T18:30:00Z', '27-28'],
    ['2026-04-01T00:00:00Z', '26-27'],
  ])('financialYearOf(%s) = %s', (iso, fy) => {
    expect(financialYearOf(new Date(iso))).toBe(fy)
  })

  it('istMidnight(2026-04-01) is 2026-03-31T18:30:00Z', () => {
    expect(istMidnight('2026-04-01').toISOString()).toBe('2026-03-31T18:30:00.000Z')
  })

  it('istMidnight reads any day, month and year, not only the first', () => {
    expect(istMidnight('2027-12-31').toISOString()).toBe('2027-12-30T18:30:00.000Z')
    expect(istMidnight('2026-10-27').toISOString()).toBe('2026-10-26T18:30:00.000Z')
  })

  it('istTime writes the IST time of day as HH:mm, across midnight', () => {
    expect(istTime(new Date('2026-10-27T06:30:00Z'))).toBe('12:00')
    expect(istTime(new Date('2026-10-27T18:45:59Z'))).toBe('00:15')
  })

  it('financialYearEndYear is the calendar year a financial year ends in', () => {
    expect(financialYearEndYear('26-27')).toBe(2027)
    expect(financialYearEndYear('99-00')).toBe(2100)
  })

  it('istDate converts to the IST day', () => {
    expect(istDate(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11-01')
    expect(istDate(new Date('2026-10-31T18:29:59Z'))).toBe('2026-10-31')
  })

  it('financialYearEnd(26-27) is 2027-03-31T18:30:00.000Z', () => {
    expect(financialYearEnd('26-27').toISOString()).toBe('2027-03-31T18:30:00.000Z')
  })

  it('late credit note: FY 26-27 deadline is the start of 1 December 2027 IST', () => {
    expect(isLateCreditNote('26-27', new Date('2027-11-30T18:29:59Z'))).toBe(false)
    expect(isLateCreditNote('26-27', new Date('2027-11-30T18:30:00Z'))).toBe(true)
  })

  it('late credit note: another year moves the deadline with it', () => {
    expect(isLateCreditNote('27-28', new Date('2027-12-01T00:00:00Z'))).toBe(false)
    expect(isLateCreditNote('27-28', new Date('2028-11-30T18:29:59Z'))).toBe(false)
    expect(isLateCreditNote('27-28', new Date('2028-11-30T18:30:00Z'))).toBe(true)
  })

  it('late invoice: 30 days exactly is not late, 30 days + 1 ms is', () => {
    const paid = new Date('2026-10-01T00:00:00Z')
    const exact = new Date(paid.getTime() + 30 * 86_400_000)
    const over = new Date(exact.getTime() + 1)
    expect(isLateInvoice(paid, exact)).toBe(false)
    expect(isLateInvoice(paid, over)).toBe(true)
  })
})

describe('formatDocumentNumber', () => {
  it('pads to five digits and caps at 16 characters', () => {
    expect(formatDocumentNumber('INV', '26-27', 1)).toBe('INV/26-27/00001')
    expect(formatDocumentNumber('INV', '26-27', 100_000)).toBe('INV/26-27/100000')
    expect(formatDocumentNumber('INV', '26-27', 100_000)).toHaveLength(16)
    expect(() => formatDocumentNumber('ABCD', '26-27', 100_000)).toThrow(RangeError)
  })

  it('fits a 3-character prefix with a 6-digit serial, the longest the prefix rule allows', () => {
    expect(formatDocumentNumber('ABC', '26-27', 999_999)).toBe('ABC/26-27/999999')
    expect(() => formatDocumentNumber('ABC', '26-27', 1_000_000)).toThrow(RangeError)
  })
})

describe('amountInWords', () => {
  it.each([
    [99_900, 'Rupees Nine Hundred Ninety-Nine Only'],
    [84_661, 'Rupees Eight Hundred Forty-Six and Sixty-One Paise Only'],
    [999_000, 'Rupees Nine Thousand Nine Hundred Ninety Only'],
    [15_000_050, 'Rupees One Lakh Fifty Thousand and Fifty Paise Only'],
    [
      1_234_567_890,
      'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight and Ninety Paise Only',
    ],
    [50, 'Rupees Zero and Fifty Paise Only'],
  ])('amountInWords(%i)', (minor, words) => {
    expect(amountInWords(minor)).toBe(words)
  })
})

describe('exportPeriodRange', () => {
  it('reads a month and a financial-year quarter as half-open IST ranges', () => {
    const m = exportPeriodRange('2026-10')
    expect(m?.from.toISOString()).toBe('2026-09-30T18:30:00.000Z')
    expect(m?.to.toISOString()).toBe('2026-10-31T18:30:00.000Z')
    expect(m?.label).toBe('2026-10')
    const q = exportPeriodRange('2026-Q4')
    expect(q?.from.toISOString()).toBe('2026-12-31T18:30:00.000Z')
    expect(q?.to.toISOString()).toBe('2027-03-31T18:30:00.000Z')
    expect(exportPeriodRange('2026-Q1')?.from.toISOString()).toBe('2026-03-31T18:30:00.000Z')
    expect(exportPeriodRange('2026-12')?.to.toISOString()).toBe('2026-12-31T18:30:00.000Z')
  })

  it.each(['2026-13', '2026-00', '2026-Q5', '2026-Q0', '26-10', 'x', ''])('%s is null', (p) => {
    expect(exportPeriodRange(p)).toBeNull()
  })

  // GST began in 2017, and a zip's DOS date stops at 2099; years 0000–0099 would also read as 19xx.
  it.each(['0000-01', '0099-Q1', '1979-12', '2016-12', '2016-Q3', '2099-Q4', '2100-01', '9999-Q1'])(
    '%s, outside 2017 to 2099, is null',
    (p) => {
      expect(exportPeriodRange(p)).toBeNull()
    }
  )

  it.each(['2017-01', '2016-Q4', '2099-12', '2099-Q3'])(
    '%s, the edge of the range, is read',
    (p) => {
      expect(exportPeriodRange(p)?.label).toBe(p)
    }
  )
})

describe('taxStatusOf', () => {
  const seller = { effectiveFrom: new Date('2026-03-31T18:30:00.000Z') }
  const paid = { status: 'paid', paymentId: 'pay_1', paidAt: '2026-10-01T00:00:00.000Z' } as const
  const document = { id: 'doc_1', number: 'INV/26-27/00001' }

  it('reads a row with a tax invoice as issued, even with registration off', () => {
    expect(taxStatusOf(paid, { taxDocument: document, held: false }, seller)).toBe('issued')
    expect(taxStatusOf(paid, { taxDocument: document, held: false }, null)).toBe('issued')
  })

  it('reads a held payment as held, resolved or not, before the paid and cutoff checks', () => {
    expect(taxStatusOf(paid, { taxDocument: null, held: true }, seller)).toBe('held')
    expect(
      taxStatusOf(
        { ...paid, paidAt: '2026-01-01T00:00:00.000Z' },
        { taxDocument: null, held: true },
        null
      )
    ).toBe('held')
  })

  it.each([
    ['an unpaid row', { ...paid, status: 'issued' }],
    ['a cancelled row', { ...paid, status: 'cancelled' }],
    ['a paid row with no payment', { ...paid, paymentId: null }],
    ['a paid row with no paid time', { ...paid, paidAt: null }],
  ] as const)('reads %s as not applicable', (_name, row) => {
    expect(taxStatusOf(row, undefined, seller)).toBe('not_applicable')
  })

  it('reads a paid row as not applicable while registration is off', () => {
    expect(taxStatusOf(paid, undefined, null)).toBe('not_applicable')
  })

  it('reads a row paid before 00:00 IST on the effective date as not applicable, and one at it as pending', () => {
    expect(taxStatusOf({ ...paid, paidAt: '2026-03-31T18:29:59.000Z' }, undefined, seller)).toBe(
      'not_applicable'
    )
    expect(taxStatusOf({ ...paid, paidAt: '2026-03-31T18:30:00.000Z' }, undefined, seller)).toBe(
      'pending'
    )
  })

  it('reads a paid row on or after the cutoff with no document as pending', () => {
    expect(taxStatusOf(paid, undefined, seller)).toBe('pending')
    expect(taxStatusOf(paid, { taxDocument: null, held: false }, seller)).toBe('pending')
  })
})
