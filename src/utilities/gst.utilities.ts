/**
 * @file Pure GST rules: GSTIN checks, tax splits, credit-note maths,
 * financial years in IST, document numbers and amounts in words. No I/O.
 */
import {
  GST_RATE_PERCENT,
  GST_STATES,
  LATE_INVOICE_DAYS,
  TAX_DOCUMENT_NUMBER_MAX_LENGTH,
  TAX_NUMBER_MIN_DIGITS,
} from '@/constants/gst.constants'

/** The amounts on a tax document, in paise. */
export interface TaxAmounts {
  totalMinor: number
  taxableMinor: number
  cgstMinor: number
  sgstMinor: number
  igstMinor: number
  ratePercent: 18
}

/** Whether a supply stays inside the seller's state (CGST + SGST) or crosses it (IGST). */
type SupplyKind = 'intra' | 'inter'

// India Standard Time is UTC+05:30 all year.
const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 86_400_000
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Trims and upper-cases a GSTIN as typed. */
export function normaliseGstin(raw: string): string {
  return raw.trim().toUpperCase()
}

/** Computes the check character of a GSTIN's first 14 characters (mod-36). */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0
  for (let index = 0; index < 14; index++) {
    const product = GSTIN_ALPHABET.indexOf(first14.charAt(index)) * (index % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_ALPHABET.charAt((36 - (sum % 36)) % 36)
}

/** Names the first rule a normalised GSTIN breaks, or null when it passes. */
export function gstinProblem(gstin: string): 'shape' | 'checksum' | 'state' | null {
  if (!GSTIN_SHAPE.test(gstin)) return 'shape'
  if (stateOf(gstin.slice(0, 2)) === undefined) return 'state'
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin.charAt(14)) return 'checksum'
  return null
}

/** Finds a selectable state by its two-digit code. */
export function stateOf(code: string): { code: string; name: string } | undefined {
  return GST_STATES.find((s) => s.code === code)
}

/** Splits a GST-inclusive total into taxable value and tax, in paise. */
export function splitInclusive(totalMinor: number, supply: SupplyKind): TaxAmounts {
  const taxableMinor = Math.floor((totalMinor * 100 + 59) / 118)
  return withTax(totalMinor, taxableMinor, totalMinor - taxableMinor, supply)
}

/** Builds amounts from a total, taxable value and tax, splitting the tax by supply kind. */
function withTax(
  totalMinor: number,
  taxableMinor: number,
  tax: number,
  supply: SupplyKind
): TaxAmounts {
  const cgstMinor = supply === 'intra' ? Math.floor(tax / 2) : 0
  return {
    totalMinor,
    taxableMinor,
    cgstMinor,
    sgstMinor: supply === 'intra' ? tax - cgstMinor : 0,
    igstMinor: supply === 'inter' ? tax : 0,
    ratePercent: GST_RATE_PERCENT,
  }
}

/** Divides and rounds half up over integers. */
function roundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d)
}

/**
 * Works out one credit note against an invoice. Notes are cumulative on the
 * invoice, so a note's amounts are the difference between the totals after and
 * before it, and all notes together equal the invoice exactly.
 */
export function creditNoteAmounts(
  invoice: TaxAmounts & { supply: SupplyKind },
  creditedBeforeMinor: number,
  amountMinor: number
): TaxAmounts {
  /** Totals credited so far, split as an invoice would be. */
  const cumulative = (credited: number) => {
    const taxable = Number(
      roundHalfUp(BigInt(invoice.taxableMinor) * BigInt(credited), BigInt(invoice.totalMinor))
    )
    return withTax(credited, taxable, credited - taxable, invoice.supply)
  }
  const before = cumulative(creditedBeforeMinor)
  const after = cumulative(creditedBeforeMinor + amountMinor)
  return {
    totalMinor: amountMinor,
    taxableMinor: after.taxableMinor - before.taxableMinor,
    cgstMinor: after.cgstMinor - before.cgstMinor,
    sgstMinor: after.sgstMinor - before.sgstMinor,
    igstMinor: after.igstMinor - before.igstMinor,
    ratePercent: GST_RATE_PERCENT,
  }
}

/** Intra-state when the seller and the place of supply share a state. */
export function supplyKind(sellerStateCode: string, placeOfSupplyCode: string): SupplyKind {
  return sellerStateCode === placeOfSupplyCode ? 'intra' : 'inter'
}

/** The buyer's GSTIN state, else the billing state, else the seller's state. */
export function placeOfSupply(
  buyer: { gstin: string | null; stateCode: string | null },
  sellerStateCode: string
): string {
  return buyer.gstin?.slice(0, 2) ?? buyer.stateCode ?? sellerStateCode
}

/** Reads a date as IST calendar parts (the UTC getters of the shifted instant). */
function istParts(at: Date): { year: number; month: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 }
}

/** The instant a calendar day begins in IST. */
function istStartOf(year: number, month: number, day = 1): Date {
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS)
}

/** The financial year (April to March, in IST) holding a date, such as '26-27'. */
export function financialYearOf(at: Date): string {
  const { year, month } = istParts(at)
  const start = month >= 4 ? year : year - 1
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** The instant 1 April after a financial year begins in IST. */
export function financialYearEnd(fy: string): Date {
  return istStartOf(2000 + Number(fy.slice(0, 2)) + 1, 4)
}

/** Builds 'INV/26-27/00001'; throws RangeError past the 16-character limit. */
export function formatDocumentNumber(prefix: string, fy: string, n: number): string {
  const number = `${prefix}/${fy}/${String(n).padStart(TAX_NUMBER_MIN_DIGITS, '0')}`
  if (number.length > TAX_DOCUMENT_NUMBER_MAX_LENGTH) {
    throw new RangeError('The document number is longer than 16 characters.')
  }
  return number
}

/** A credit note is late when issued from 1 December IST after its invoice's year ends. */
export function isLateCreditNote(invoiceFy: string, issuedAt: Date): boolean {
  return issuedAt.getTime() >= istStartOf(2000 + Number(invoiceFy.slice(0, 2)) + 1, 12).getTime()
}

/** An invoice is late when issued more than 30 days after the payment. */
export function isLateInvoice(paidAt: Date, issuedAt: Date): boolean {
  return issuedAt.getTime() - paidAt.getTime() > LATE_INVOICE_DAYS * DAY_MS
}

/** The instant a 'YYYY-MM-DD' day begins in IST. */
export function istMidnight(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number)
  return istStartOf(year ?? 0, month ?? 1, day ?? 1)
}

/** The IST calendar day of an instant as 'YYYY-MM-DD'. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** Words for 1 to 99. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const ones = n % 10
  return `${TENS[Math.floor(n / 10)]}${ones === 0 ? '' : `-${ONES[ones]}`}`
}

/** Words for 1 to 999,999,999 in the Indian system. */
function indianWords(n: number): string {
  const parts: string[] = []
  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor(n / 100_000) % 100
  const thousand = Math.floor(n / 1000) % 100
  const hundred = Math.floor(n / 100) % 10
  const rest = n % 100
  if (crore > 0) parts.push(`${indianWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${underHundred(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${underHundred(thousand)} Thousand`)
  if (hundred > 0) parts.push(`${ONES[hundred]} Hundred`)
  if (rest > 0) parts.push(underHundred(rest))
  return parts.join(' ')
}

/** Writes an amount in paise as 'Rupees … and … Paise Only' (Indian system). */
export function amountInWords(minor: number): string {
  const rupees = Math.floor(minor / 100)
  const paise = minor % 100
  const rupeeWords = rupees === 0 ? 'Zero' : indianWords(rupees)
  return `Rupees ${rupeeWords}${paise === 0 ? '' : ` and ${underHundred(paise)} Paise`} Only`
}

/**
 * Reads an export period ('YYYY-MM' or 'YYYY-Qn', n of the financial year that
 * starts in April of YYYY) as a half-open IST range, or null when malformed.
 */
export function exportPeriodRange(period: string): { from: Date; to: Date; label: string } | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  if (month) {
    const year = Number(month[1])
    const m = Number(month[2])
    return {
      from: istStartOf(year, m),
      to: istStartOf(m === 12 ? year + 1 : year, (m % 12) + 1),
      label: period,
    }
  }
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period)
  if (quarter) {
    const year = Number(quarter[1])
    const startMonth = 4 + (Number(quarter[2]) - 1) * 3
    const endMonth = startMonth + 3
    return {
      from: istStartOf(year + Math.floor((startMonth - 1) / 12), ((startMonth - 1) % 12) + 1),
      to: istStartOf(year + Math.floor((endMonth - 1) / 12), ((endMonth - 1) % 12) + 1),
      label: period,
    }
  }
  return null
}
