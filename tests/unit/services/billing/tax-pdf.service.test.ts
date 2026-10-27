/**
 * @file The printed content of tax documents and their PDF bytes: every
 * field an invoice and a credit note must show, the intra-state and
 * inter-state tax rows, the late credit note line, and a PDF that is small
 * and renders to the same bytes every time, in any time zone.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { COMPUTER_GENERATED_SENTENCE } from '@/constants/tax-document-text.constants'
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import { renderTaxDocumentPdf, taxDocumentLines } from '@/services/billing/tax-pdf.service'
import type { TaxDocumentSnapshot } from '@/types/tax'

const KARNATAKA = { code: '29', name: 'Karnataka' }
const MAHARASHTRA = { code: '27', name: 'Maharashtra' }

/**
 * The snapshot of an intra-state invoice of ₹999 to a Karnataka buyer with a GSTIN.
 */
const INTRA_SNAPSHOT: TaxDocumentSnapshot = {
  version: 1,
  seller: {
    legalName: 'Mahaverick Labs Pvt Ltd',
    addressLines: ['12 MG Road', 'Bengaluru 560001'],
    gstin: '29AABCE1234F1Z1',
    state: KARNATAKA,
  },
  buyer: {
    legalName: "O'Brien Traders",
    gstin: '29ABCDE1234F1ZW',
    addressLines: ['4 Brigade Road', 'Floor 2', 'Bengaluru 560025'],
    state: KARNATAKA,
    source: 'tax_details',
  },
  placeOfSupply: KARNATAKA,
  supply: 'intra',
  sacCode: '998314',
  description: 'Paid plan, monthly',
  billingPeriod: { start: '2026-10-01', end: '2026-10-31' },
  amounts: {
    totalMinor: 99_900,
    taxableMinor: 84_661,
    cgstMinor: 7619,
    sgstMinor: 7620,
    igstMinor: 0,
    ratePercent: 18,
  },
  reference: { paymentId: 'pay_TEST0001', refundId: null },
  original: null,
  reason: null,
}

/**
 * A stored invoice row, overridable per field.
 * @param overrides - Columns to change.
 * @returns The row.
 */
function invoiceRow(overrides: Partial<TaxDocumentRecord> = {}): TaxDocumentRecord {
  return {
    id: '0192f6a4-3c1e-7b2a-9d4e-5f6a7b8c9d0e',
    type: 'invoice',
    number: 'INV/26-27/00001',
    financialYear: '26-27',
    // 27 October 2026, 00:30 IST: still 26 October in UTC.
    issuedAt: new Date('2026-10-26T19:00:00.000Z'),
    tenantId: '0192f6a4-3c1e-7b2a-9d4e-000000000001',
    provider: 'razorpay',
    providerMode: 'test',
    paymentId: 'pay_TEST0001',
    refundId: null,
    subscriptionId: 'sub_TEST0001',
    originalDocumentId: null,
    totalMinor: 99_900,
    taxableMinor: 84_661,
    cgstMinor: 7619,
    sgstMinor: 7620,
    igstMinor: 0,
    supply: 'intra',
    placeOfSupply: '29',
    buyerGstin: '29ABCDE1234F1ZW',
    snapshot: INTRA_SNAPSHOT,
    noTaxReduction: false,
    reason: null,
    createdBy: null,
    ...overrides,
  }
}

/**
 * An inter-state invoice of ₹999 to a Maharashtra buyer.
 * @returns The row.
 */
function interRow(): TaxDocumentRecord {
  return invoiceRow({
    supply: 'inter',
    placeOfSupply: '27',
    buyerGstin: '27ABCDE1234F1Z0',
    cgstMinor: 0,
    sgstMinor: 0,
    igstMinor: 15_239,
    snapshot: {
      ...INTRA_SNAPSHOT,
      buyer: { ...INTRA_SNAPSHOT.buyer, gstin: '27ABCDE1234F1Z0', state: MAHARASHTRA },
      placeOfSupply: MAHARASHTRA,
      supply: 'inter',
      amounts: { ...INTRA_SNAPSHOT.amounts, cgstMinor: 0, sgstMinor: 0, igstMinor: 15_239 },
    },
  })
}

/**
 * A credit note of ₹500 for a refund against the intra-state invoice.
 * @param overrides - Columns to change.
 * @returns The row.
 */
function creditNoteRow(overrides: Partial<TaxDocumentRecord> = {}): TaxDocumentRecord {
  return invoiceRow({
    id: '0192f6a4-3c1e-7b2a-9d4e-5f6a7b8c9d0f',
    type: 'credit_note',
    number: 'CN/26-27/00001',
    issuedAt: new Date('2026-11-03T06:00:00.000Z'),
    refundId: 'rfnd_TEST0001',
    originalDocumentId: '0192f6a4-3c1e-7b2a-9d4e-5f6a7b8c9d0e',
    totalMinor: 50_000,
    taxableMinor: 42_373,
    cgstMinor: 3813,
    sgstMinor: 3814,
    reason: 'Refund',
    snapshot: {
      ...INTRA_SNAPSHOT,
      amounts: {
        totalMinor: 50_000,
        taxableMinor: 42_373,
        cgstMinor: 3813,
        sgstMinor: 3814,
        igstMinor: 0,
        ratePercent: 18,
      },
      reference: { paymentId: 'pay_TEST0001', refundId: 'rfnd_TEST0001' },
      original: { number: 'INV/26-27/00001', issuedAt: '2026-10-26T19:00:00.000Z' },
      reason: 'Refund',
    },
    ...overrides,
  })
}

/**
 * Every printed line of a document, the title first, in print order.
 * @param row - The document.
 * @returns The lines.
 */
function printed(row: TaxDocumentRecord): string[] {
  const lines = taxDocumentLines(row)
  return [
    lines.title,
    ...lines.sections.flatMap((section) => [
      ...(section.heading === null ? [] : [section.heading]),
      ...section.lines,
    ]),
  ]
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('taxDocumentLines', () => {
  it('prints every field of an intra-state invoice, dated in IST', () => {
    const lines = printed(invoiceRow())

    expect(lines[0]).toBe('Tax Invoice')
    expect(lines).toEqual(
      expect.arrayContaining([
        'Number: INV/26-27/00001',
        'Date: 27 October 2026',
        'Mahaverick Labs Pvt Ltd',
        '12 MG Road',
        'Bengaluru 560001',
        'GSTIN: 29AABCE1234F1Z1',
        'State: Karnataka (29)',
        "O'Brien Traders",
        'GSTIN: 29ABCDE1234F1ZW',
        '4 Brigade Road',
        'Floor 2',
        'Bengaluru 560025',
        'Place of supply: Karnataka (29)',
        'SAC 998314',
        'Paid plan, monthly',
        'Period: 1 October 2026 to 31 October 2026',
        'Taxable value: Rs. 846.61',
        'CGST 9%: Rs. 76.19',
        'SGST 9%: Rs. 76.20',
        'Total: Rs. 999.00',
        'Rupees Nine Hundred Ninety-Nine Only',
        'Reverse charge: No',
        'Payment reference: pay_TEST0001',
        COMPUTER_GENERATED_SENTENCE,
      ])
    )
    expect(COMPUTER_GENERATED_SENTENCE).toBe(
      'This is a computer-generated document and needs no signature.'
    )
    expect(lines.filter((line) => line.startsWith('IGST'))).toStrictEqual([])
    expect(lines.filter((line) => line.startsWith('Original invoice'))).toStrictEqual([])
    expect(lines).not.toContain('No tax reduction (s.34(2))')
  })

  it('prints IGST and no CGST or SGST for an inter-state invoice', () => {
    const lines = printed(interRow())

    expect(lines).toEqual(
      expect.arrayContaining([
        'IGST 18%: Rs. 152.39',
        'Place of supply: Maharashtra (27)',
        'State: Maharashtra (27)',
      ])
    )
    expect(lines.filter((line) => /^[CS]GST/.test(line))).toStrictEqual([])
  })

  it('groups large amounts the Indian way', () => {
    const lines = printed(
      invoiceRow({
        snapshot: {
          ...INTRA_SNAPSHOT,
          amounts: {
            totalMinor: 11_800_000,
            taxableMinor: 10_000_000,
            cgstMinor: 900_000,
            sgstMinor: 900_000,
            igstMinor: 0,
            ratePercent: 18,
          },
        },
      })
    )

    expect(lines).toEqual(
      expect.arrayContaining([
        'Total: Rs. 1,18,000.00',
        'Taxable value: Rs. 1,00,000.00',
        'CGST 9%: Rs. 9,000.00',
        'Rupees One Lakh Eighteen Thousand Only',
      ])
    )
  })

  it('prints a buyer with no tax details by name alone', () => {
    const lines = printed(
      invoiceRow({
        buyerGstin: null,
        snapshot: {
          ...INTRA_SNAPSHOT,
          buyer: {
            legalName: 'Acme Studio',
            gstin: null,
            addressLines: [],
            state: null,
            source: 'workspace',
          },
          billingPeriod: null,
        },
      })
    )
    const buyer = taxDocumentLines(invoiceRow()).sections.find(
      (section) => section.heading === 'Buyer'
    )

    expect(buyer?.lines).toStrictEqual([
      "O'Brien Traders",
      'GSTIN: 29ABCDE1234F1ZW',
      '4 Brigade Road',
      'Floor 2',
      'Bengaluru 560025',
      'State: Karnataka (29)',
    ])
    expect(lines).toContain('Acme Studio')
    expect(lines.filter((line) => line.startsWith('GSTIN'))).toStrictEqual([
      'GSTIN: 29AABCE1234F1Z1',
    ])
    expect(lines.filter((line) => line.startsWith('Period'))).toStrictEqual([])
  })

  it('prints a credit note with its original invoice and reason', () => {
    const lines = printed(creditNoteRow())

    expect(lines[0]).toBe('Credit Note')
    expect(lines).toEqual(
      expect.arrayContaining([
        'Number: CN/26-27/00001',
        'Date: 3 November 2026',
        'Original invoice: INV/26-27/00001 dated 27 October 2026',
        'Taxable value: Rs. 423.73',
        'CGST 9%: Rs. 38.13',
        'SGST 9%: Rs. 38.14',
        'Total: Rs. 500.00',
        'Rupees Five Hundred Only',
        'Reason: Refund',
        'Refund reference: rfnd_TEST0001',
        'Reverse charge: No',
        COMPUTER_GENERATED_SENTENCE,
      ])
    )
    expect(lines).not.toContain('No tax reduction (s.34(2))')
  })

  it('prints the no-tax-reduction line on a late credit note', () => {
    const lines = printed(
      creditNoteRow({ issuedAt: new Date('2027-12-01T06:00:00.000Z'), noTaxReduction: true })
    )

    expect(lines).toContain('No tax reduction (s.34(2))')
    expect(lines).toContain('Date: 1 December 2027')
  })
})

describe('renderTaxDocumentPdf', () => {
  it('renders a small one-page PDF', async () => {
    const pdf = await renderTaxDocumentPdf(creditNoteRow({ noTaxReduction: true }))

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeLessThan(60 * 1024)
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1)
  })

  it('fits the longest legal inputs on one page', async () => {
    const name = 'N'.repeat(100)
    const line = 'A'.repeat(100)
    const row = creditNoteRow({
      noTaxReduction: true,
      reason: 'R'.repeat(500),
      snapshot: {
        ...creditNoteRow().snapshot,
        seller: { ...INTRA_SNAPSHOT.seller, legalName: name, addressLines: [line, line, line] },
        buyer: { ...INTRA_SNAPSHOT.buyer, legalName: name, addressLines: [line, line, line] },
        description: 'D'.repeat(100),
        reason: 'R'.repeat(500),
      },
    })

    const pdf = await renderTaxDocumentPdf(row)

    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1)
  })

  it('renders one row to the same bytes every time, in any time zone and at any clock time', async () => {
    const row = creditNoteRow()
    vi.stubEnv('TZ', 'UTC')
    const first = await renderTaxDocumentPdf(row)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1000)
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const second = await renderTaxDocumentPdf(row)

    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-330)
    expect(second.equals(first)).toBe(true)
  })

  it('renders different rows to different bytes', async () => {
    const invoice = await renderTaxDocumentPdf(invoiceRow())
    const note = await renderTaxDocumentPdf(creditNoteRow())

    expect(note.equals(invoice)).toBe(false)
  })
})
