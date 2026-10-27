/**
 * @file The GSTR-1 CSVs built from a fixed set of documents: the B2B rows,
 * the B2C summary net of credit notes, the CDNR rows, the SAC summaries, the
 * document series, the late credit notes, and the CSV cell rules (quoting and
 * the formula guard).
 */
import { describe, expect, it } from 'vite-plus/test'
import type { ExportDocument } from '@/repositories/platform-tax.repository'
import { buildGstr1Csvs, csvCell } from '@/services/platform-tax-export.service'
import type { TaxDocumentSnapshot } from '@/types/tax'
import { creditNoteAmounts, splitInclusive, stateOf } from '@/utilities/gst.utilities'

const SELLER_STATE = '29'

/**
 * What a test document varies.
 */
interface DocumentSpec {
  type: 'invoice' | 'credit_note'
  number: string
  issuedAt: string
  totalMinor: number
  buyerGstin: string | null
  buyerName: string
  placeOfSupply: string
  original?: { number: string; issuedAt: string; buyerGstin: string | null; totalMinor: number }
  noTaxReduction?: boolean
}

/**
 * Build one export document the way the issue path stores it: amounts split
 * by the GST rules, the snapshot holding the printed fields.
 * @param spec - What varies.
 * @returns The document.
 */
function documentOf(spec: DocumentSpec): ExportDocument {
  const supply = spec.placeOfSupply === SELLER_STATE ? 'intra' : 'inter'
  const amounts =
    spec.original === undefined
      ? splitInclusive(spec.totalMinor, supply)
      : creditNoteAmounts(
          { ...splitInclusive(spec.original.totalMinor, supply), supply },
          0,
          spec.totalMinor
        )
  const state = stateOf(spec.placeOfSupply)
  if (state === undefined) throw new Error('fixture: unknown state')
  const snapshot: TaxDocumentSnapshot = {
    version: 1,
    seller: {
      legalName: 'Seller Pvt Ltd',
      addressLines: ['1 Road'],
      gstin: '29AABCE1234F1Z1',
      state: { code: '29', name: 'Karnataka' },
    },
    buyer: {
      legalName: spec.buyerName,
      gstin: spec.buyerGstin,
      addressLines: [],
      state,
      source: spec.buyerGstin === null ? 'workspace' : 'tax_details',
    },
    placeOfSupply: state,
    supply,
    sacCode: '998431',
    description: 'Paid, Monthly',
    billingPeriod: null,
    amounts,
    reference: { paymentId: null, refundId: null },
    original:
      spec.original === undefined
        ? null
        : { number: spec.original.number, issuedAt: spec.original.issuedAt },
    reason: null,
  }
  return {
    id: spec.number,
    type: spec.type,
    number: spec.number,
    financialYear: '26-27',
    issuedAt: new Date(spec.issuedAt),
    tenantId: null,
    provider: 'razorpay',
    providerMode: 'test',
    paymentId: null,
    refundId: null,
    subscriptionId: null,
    originalDocumentId: spec.original === undefined ? null : spec.original.number,
    totalMinor: amounts.totalMinor,
    taxableMinor: amounts.taxableMinor,
    cgstMinor: amounts.cgstMinor,
    sgstMinor: amounts.sgstMinor,
    igstMinor: amounts.igstMinor,
    supply,
    placeOfSupply: spec.placeOfSupply,
    buyerGstin: spec.buyerGstin,
    snapshot,
    noTaxReduction: spec.noTaxReduction ?? false,
    reason: null,
    createdBy: null,
    original:
      spec.original === undefined
        ? null
        : {
            number: spec.original.number,
            issuedAt: new Date(spec.original.issuedAt),
            buyerGstin: spec.original.buyerGstin,
          },
  }
}

// 27 Oct 2026, 12:00 IST.
const B2B_INVOICE = documentOf({
  type: 'invoice',
  number: 'INV/26-27/00001',
  issuedAt: '2026-10-27T06:30:00.000Z',
  totalMinor: 99_900,
  buyerGstin: '27ABCDE1234F1Z0',
  buyerName: 'Buyer Pvt Ltd',
  placeOfSupply: '27',
})
const B2C_INVOICE_A = documentOf({
  type: 'invoice',
  number: 'INV/26-27/00002',
  issuedAt: '2026-10-27T07:00:00.000Z',
  totalMinor: 99_900,
  buyerGstin: null,
  buyerName: 'Small Co',
  placeOfSupply: '29',
})
const B2C_INVOICE_B = documentOf({
  type: 'invoice',
  number: 'INV/26-27/00003',
  issuedAt: '2026-10-27T08:00:00.000Z',
  totalMinor: 99_900,
  buyerGstin: null,
  buyerName: 'Other Co',
  placeOfSupply: '29',
})
// 28 Oct 2026 IST: a refund of ₹500 on a B2C invoice.
const B2C_NOTE = documentOf({
  type: 'credit_note',
  number: 'CN/26-27/00001',
  issuedAt: '2026-10-28T06:30:00.000Z',
  totalMinor: 50_000,
  buyerGstin: null,
  buyerName: 'Small Co',
  placeOfSupply: '29',
  original: {
    number: 'INV/26-27/00002',
    issuedAt: '2026-10-27T07:00:00.000Z',
    buyerGstin: null,
    totalMinor: 99_900,
  },
})
// A ₹500 note on the B2B invoice.
const B2B_NOTE = documentOf({
  type: 'credit_note',
  number: 'CN/26-27/00002',
  issuedAt: '2026-10-28T07:00:00.000Z',
  totalMinor: 50_000,
  buyerGstin: '27ABCDE1234F1Z0',
  buyerName: 'Buyer Pvt Ltd',
  placeOfSupply: '27',
  original: {
    number: 'INV/26-27/00001',
    issuedAt: '2026-10-27T06:30:00.000Z',
    buyerGstin: '27ABCDE1234F1Z0',
    totalMinor: 99_900,
  },
})
// A note issued after the s.34(2) deadline: it refunds but reduces no tax.
const LATE_B2C_NOTE = documentOf({
  type: 'credit_note',
  number: 'CN/26-27/00003',
  issuedAt: '2026-10-29T06:30:00.000Z',
  totalMinor: 20_000,
  buyerGstin: null,
  buyerName: 'Old Co',
  placeOfSupply: '29',
  original: {
    number: 'INV/25-26/00009',
    issuedAt: '2025-06-10T06:30:00.000Z',
    buyerGstin: null,
    totalMinor: 99_900,
  },
  noTaxReduction: true,
})

const HEADERS = {
  'b2b.csv':
    'GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,Place Of Supply,Reverse Charge,Applicable % of Tax Rate,Invoice Type,E-Commerce GSTIN,Rate,Taxable Value,Cess Amount',
  'b2cs.csv':
    'Type,Place Of Supply,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,E-Commerce GSTIN',
  'cdnr.csv':
    'GSTIN/UIN of Recipient,Receiver Name,Note Number,Note Date,Note Type,Place Of Supply,Reverse Charge,Note Supply Type,Note Value,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,Original Invoice Number,Original Invoice Date',
  'hsn-b2b.csv':
    'HSN,Description,UQC,Total Quantity,Total Value,Rate,Taxable Value,Integrated Tax Amount,Central Tax Amount,State/UT Tax Amount,Cess Amount',
  'hsn-b2c.csv':
    'HSN,Description,UQC,Total Quantity,Total Value,Rate,Taxable Value,Integrated Tax Amount,Central Tax Amount,State/UT Tax Amount,Cess Amount',
  'docs.csv': 'Nature of Document,Sr. No. From,Sr. No. To,Total Number,Cancelled',
  'late-credit-notes.csv':
    'Note Number,Note Date,Original Invoice Number,Original Invoice Date,GSTIN/UIN of Recipient,Receiver Name,Note Value,Taxable Value,Central Tax Amount,State/UT Tax Amount,Integrated Tax Amount',
}

/**
 * The data rows of one CSV, without its header.
 * @param csv - The file's text.
 * @returns Its rows.
 */
function rowsOf(csv: string): string[] {
  return csv.split('\r\n').slice(1, -1)
}

describe('buildGstr1Csvs', () => {
  const PERIOD = [B2B_INVOICE, B2C_INVOICE_A, B2C_INVOICE_B, B2B_NOTE, B2C_NOTE]

  it('writes the seven files, each starting with its GST tool header and ending every line in CRLF', () => {
    const files = buildGstr1Csvs(PERIOD)

    expect(Object.keys(files)).toEqual([
      'b2b.csv',
      'b2cs.csv',
      'cdnr.csv',
      'hsn-b2b.csv',
      'hsn-b2c.csv',
      'docs.csv',
      'late-credit-notes.csv',
    ])
    for (const [name, header] of Object.entries(HEADERS)) {
      const text = files[name as keyof typeof files]
      expect(text.startsWith(`${header}\r\n`)).toBe(true)
      expect(text.endsWith('\r\n')).toBe(true)
      expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
    }
  })

  it('writes headers only for a period with no documents', () => {
    const files = buildGstr1Csvs([])

    for (const [name, header] of Object.entries(HEADERS)) {
      expect(files[name as keyof typeof files]).toBe(`${header}\r\n`)
    }
  })

  it('lists a B2B invoice in b2b.csv with its IST date, value and place of supply', () => {
    expect(rowsOf(buildGstr1Csvs(PERIOD)['b2b.csv'])).toEqual([
      '27ABCDE1234F1Z0,Buyer Pvt Ltd,INV/26-27/00001,27-Oct-2026,999.00,27-Maharashtra,N,,Regular B2B,,18,846.61,0.00',
    ])
  })

  it('dates a document by its IST day: 00:30 IST on 1 November is still 31 October in UTC', () => {
    const lateEvening = documentOf({
      type: 'invoice',
      number: 'INV/26-27/00004',
      // 1 Nov 2026, 00:30 IST.
      issuedAt: '2026-10-31T19:00:00.000Z',
      totalMinor: 99_900,
      buyerGstin: '27ABCDE1234F1Z0',
      buyerName: 'Buyer Pvt Ltd',
      placeOfSupply: '27',
    })

    expect(rowsOf(buildGstr1Csvs([lateEvening])['b2b.csv'])[0]).toContain(
      'INV/26-27/00004,01-Nov-2026,'
    )
  })

  it('nets B2C credit notes into b2cs.csv, one row per place of supply', () => {
    // 2 × 84661 taxable, less the note's 42373 = 126949 paise.
    expect(rowsOf(buildGstr1Csvs(PERIOD)['b2cs.csv'])).toEqual([
      'OE,29-Karnataka,,18,1269.49,0.00,',
    ])
  })

  it('writes a negative B2C summary unguarded when a period holds only a note', () => {
    expect(rowsOf(buildGstr1Csvs([B2C_NOTE])['b2cs.csv'])).toEqual([
      'OE,29-Karnataka,,18,-423.73,0.00,',
    ])
  })

  it('lists a late credit note only in late-credit-notes.csv and never subtracts it', () => {
    const files = buildGstr1Csvs([...PERIOD, LATE_B2C_NOTE])

    expect(rowsOf(files['b2cs.csv'])).toEqual(['OE,29-Karnataka,,18,1269.49,0.00,'])
    expect(rowsOf(files['hsn-b2c.csv'])).toEqual([
      '998431,Software subscription,NA,0,1498.00,18,1269.49,0.00,114.25,114.26,0.00',
    ])
    expect(rowsOf(files['cdnr.csv'])).toHaveLength(1)
    // 20000 on a 99900 intra invoice: taxable 16949, CGST 1525, SGST 1526.
    expect(rowsOf(files['late-credit-notes.csv'])).toEqual([
      'CN/26-27/00003,29-Oct-2026,INV/25-26/00009,10-Jun-2025,,Old Co,200.00,169.49,15.25,15.26,0.00',
    ])
  })

  it('leaves a late B2B credit note out of cdnr.csv and hsn-b2b.csv', () => {
    const late = { ...B2B_NOTE, number: 'CN/26-27/00004', noTaxReduction: true }

    const files = buildGstr1Csvs([B2B_INVOICE, late])

    expect(rowsOf(files['cdnr.csv'])).toEqual([])
    expect(rowsOf(files['hsn-b2b.csv'])).toEqual([
      '998431,Software subscription,NA,0,999.00,18,846.61,152.39,0.00,0.00,0.00',
    ])
    expect(rowsOf(files['late-credit-notes.csv'])[0]).toBe(
      'CN/26-27/00004,28-Oct-2026,INV/26-27/00001,27-Oct-2026,27ABCDE1234F1Z0,Buyer Pvt Ltd,500.00,423.73,0.00,0.00,76.27'
    )
  })

  it('lists a B2B credit note in cdnr.csv with its original invoice number and date', () => {
    expect(rowsOf(buildGstr1Csvs(PERIOD)['cdnr.csv'])).toEqual([
      '27ABCDE1234F1Z0,Buyer Pvt Ltd,CN/26-27/00002,28-Oct-2026,C,27-Maharashtra,N,Regular B2B,500.00,,18,423.73,0.00,INV/26-27/00001,27-Oct-2026',
    ])
  })

  it('summarises by SAC, split B2B and B2C, with invoices less non-late notes', () => {
    const files = buildGstr1Csvs(PERIOD)

    // B2C: taxable 1269.49, CGST 2 × 76.19 − 38.13, SGST 2 × 76.20 − 38.14; total = their sum.
    expect(rowsOf(files['hsn-b2c.csv'])).toEqual([
      '998431,Software subscription,NA,0,1498.00,18,1269.49,0.00,114.25,114.26,0.00',
    ])
    // B2B: 999.00 less 500.00, IGST 152.39 − 76.27.
    expect(rowsOf(files['hsn-b2b.csv'])).toEqual([
      '998431,Software subscription,NA,0,499.00,18,422.88,76.12,0.00,0.00,0.00',
    ])
  })

  it('writes one docs.csv row per series, late notes included', () => {
    expect(rowsOf(buildGstr1Csvs([...PERIOD, LATE_B2C_NOTE])['docs.csv'])).toEqual([
      'Invoices for outward supply,INV/26-27/00001,INV/26-27/00003,3,0',
      'Credit Note,CN/26-27/00001,CN/26-27/00003,3,0',
    ])
  })

  it('orders a series by serial number, not by text, past the padding', () => {
    const big = { ...B2C_INVOICE_A, number: 'INV/26-27/100000' }
    const small = { ...B2C_INVOICE_B, number: 'INV/26-27/99999' }

    expect(rowsOf(buildGstr1Csvs([big, small])['docs.csv'])).toEqual([
      'Invoices for outward supply,INV/26-27/99999,INV/26-27/100000,2,0',
    ])
  })

  it('guards and quotes a buyer name that starts with = and holds a quote', () => {
    const risky = documentOf({
      type: 'invoice',
      number: 'INV/26-27/00005',
      issuedAt: '2026-10-27T06:30:00.000Z',
      totalMinor: 99_900,
      buyerGstin: '27ABCDE1234F1Z0',
      buyerName: '=HYPERLINK("x")',
      placeOfSupply: '27',
    })

    expect(rowsOf(buildGstr1Csvs([risky])['b2b.csv'])[0]).toBe(
      `27ABCDE1234F1Z0,"'=HYPERLINK(""x"")",INV/26-27/00005,27-Oct-2026,999.00,27-Maharashtra,N,,Regular B2B,,18,846.61,0.00`
    )
  })
})

describe('csvCell', () => {
  it.each([
    ['=SUM(A1)', `'=SUM(A1)`],
    ['+1', `'+1`],
    ['-1', `'-1`],
    ['@cmd', `'@cmd`],
    ['\tTab', `'\tTab`],
    ['\rReturn', `"'\rReturn"`],
    ['A, "B"', `"A, ""B"""`],
    ['Line\nbreak', `"Line\nbreak"`],
    ['Plain Co', 'Plain Co'],
    ['', ''],
    ['a=b', 'a=b'],
  ])('writes %j as %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected)
  })
})
