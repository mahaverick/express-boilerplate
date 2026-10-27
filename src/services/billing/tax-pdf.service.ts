/**
 * @file A tax document as printed text and as a PDF. `taxDocumentLines`
 * reads only the stored row and its frozen snapshot, so a document prints
 * the same after its workspace changes or is gone. `renderTaxDocumentPdf`
 * lays those lines out on one A4 page in the standard Helvetica fonts, with
 * the PDF's dates taken from the issue time, so one row always renders to
 * the same bytes. No I/O.
 */
import PDFDocument from 'pdfkit'
import type { GstState } from '@/constants/gst.constants'
import {
  COMPUTER_GENERATED_SENTENCE,
  CREDIT_NOTE_TITLE,
  NO_TAX_REDUCTION_SENTENCE,
  REVERSE_CHARGE_SENTENCE,
  TAX_DOCUMENT_PDF_PRODUCER,
  TAX_INVOICE_TITLE,
} from '@/constants/tax-document-text.constants'
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import { amountInWords, istDate } from '@/utilities/gst.utilities'

/**
 * One block of a printed document: an optional bold heading, then its lines.
 */
interface TaxDocumentSection {
  heading: string | null
  lines: string[]
}

/**
 * What a tax document prints, in order: its title, then its sections.
 */
export interface TaxDocumentLines {
  title: string
  sections: TaxDocumentSection[]
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const TITLE_SIZE = 18
const HEADING_SIZE = 11
const BODY_SIZE = 10

/**
 * A `YYYY-MM-DD` day written out, such as `27 October 2026`. Built by hand,
 * not with `Intl`, so the text never depends on the runtime's locale data.
 * @param isoDay - The day.
 * @returns The written date.
 */
function writtenDay(isoDay: string): string {
  const [year, month, day] = isoDay.split('-').map(Number)
  return `${day ?? 0} ${MONTHS[(month ?? 1) - 1] ?? ''} ${year ?? 0}`
}

/**
 * An instant's IST calendar day written out.
 * @param at - The instant.
 * @returns The written date.
 */
function istWrittenDate(at: Date): string {
  return writtenDay(istDate(at))
}

/**
 * An amount in paise as `Rs. 1,00,000.00`, grouped the Indian way.
 * @param minor - The amount in paise, not negative.
 * @returns The written amount.
 */
function rupees(minor: number): string {
  const digits = String(Math.floor(minor / 100))
  const groups = [digits.slice(-3)]
  // Above the last three digits, the Indian system groups by two.
  for (let end = digits.length - 3; end > 0; end -= 2) {
    groups.unshift(digits.slice(Math.max(0, end - 2), end))
  }
  const grouped = groups.join(',')
  return `Rs. ${grouped}.${String(minor % 100).padStart(2, '0')}`
}

/**
 * A state with its code, such as `Karnataka (29)`.
 * @param state - The state.
 * @returns The written state.
 */
function stateLine(state: GstState): string {
  return `${state.name} (${state.code})`
}

/**
 * The tax rows: CGST and SGST at half the rate each for an intra-state
 * supply, IGST at the full rate for an inter-state one.
 * @param document - The document.
 * @returns The rows.
 */
function taxRows(document: TaxDocumentRecord): string[] {
  const { amounts } = document.snapshot
  if (document.supply === 'inter') {
    return [`IGST ${amounts.ratePercent}%: ${rupees(amounts.igstMinor)}`]
  }
  const half = amounts.ratePercent / 2
  return [
    `CGST ${half}%: ${rupees(amounts.cgstMinor)}`,
    `SGST ${half}%: ${rupees(amounts.sgstMinor)}`,
  ]
}

/**
 * What a tax document prints, from the row and its frozen snapshot: the
 * title, number and IST issue date; the seller and buyer; the place of
 * supply and, for a credit note, the invoice it reduces; the SAC line and
 * taxable value; the tax rows; the total in figures and words; then the
 * reverse-charge line, the references, a credit note's reason, the
 * no-tax-reduction line when it applies, and the no-signature line.
 * @param document - The stored document.
 * @returns The printed text.
 */
export function taxDocumentLines(document: TaxDocumentRecord): TaxDocumentLines {
  const { snapshot } = document
  const isCreditNote = document.type === 'credit_note'
  const { seller, buyer, amounts } = snapshot
  const period = snapshot.billingPeriod
  return {
    title: isCreditNote ? CREDIT_NOTE_TITLE : TAX_INVOICE_TITLE,
    sections: [
      {
        heading: null,
        lines: [`Number: ${document.number}`, `Date: ${istWrittenDate(document.issuedAt)}`],
      },
      {
        heading: 'Seller',
        lines: [
          seller.legalName,
          ...seller.addressLines,
          `GSTIN: ${seller.gstin}`,
          `State: ${stateLine(seller.state)}`,
        ],
      },
      {
        heading: 'Buyer',
        lines: [
          buyer.legalName,
          ...(buyer.gstin === null ? [] : [`GSTIN: ${buyer.gstin}`]),
          ...buyer.addressLines,
          ...(buyer.state === null ? [] : [`State: ${stateLine(buyer.state)}`]),
        ],
      },
      {
        heading: null,
        lines: [
          `Place of supply: ${stateLine(snapshot.placeOfSupply)}`,
          ...(snapshot.original === null
            ? []
            : [
                `Original invoice: ${snapshot.original.number} dated ${istWrittenDate(new Date(snapshot.original.issuedAt))}`,
              ]),
        ],
      },
      {
        heading: 'Service',
        lines: [
          `SAC ${snapshot.sacCode}`,
          snapshot.description,
          ...(period === null
            ? []
            : [`Period: ${writtenDay(period.start)} to ${writtenDay(period.end)}`]),
          `Taxable value: ${rupees(amounts.taxableMinor)}`,
        ],
      },
      { heading: 'Tax', lines: taxRows(document) },
      {
        heading: null,
        lines: [`Total: ${rupees(amounts.totalMinor)}`, amountInWords(amounts.totalMinor)],
      },
      {
        heading: null,
        lines: [
          REVERSE_CHARGE_SENTENCE,
          ...(snapshot.reference.paymentId === null
            ? []
            : [`Payment reference: ${snapshot.reference.paymentId}`]),
          ...(snapshot.reference.refundId === null
            ? []
            : [`Refund reference: ${snapshot.reference.refundId}`]),
          ...(isCreditNote && snapshot.reason !== null ? [`Reason: ${snapshot.reason}`] : []),
          ...(document.noTaxReduction ? [NO_TAX_REDUCTION_SENTENCE] : []),
          COMPUTER_GENERATED_SENTENCE,
        ],
      },
    ],
  }
}

/**
 * Render a tax document as a one-page A4 PDF. The PDF's title is the
 * document number, its author the seller's legal name, its producer a fixed
 * string, and its creation and change dates the issue time, so the file id
 * pdfkit derives from them, and so every byte, is the same on every render.
 * @param document - The stored document.
 * @returns The PDF bytes.
 */
export async function renderTaxDocumentPdf(document: TaxDocumentRecord): Promise<Buffer> {
  const lines = taxDocumentLines(document)
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 50,
    font: 'Helvetica',
    info: {
      Title: document.number,
      Author: document.snapshot.seller.legalName,
      Producer: TAX_DOCUMENT_PDF_PRODUCER,
      Creator: TAX_DOCUMENT_PDF_PRODUCER,
      CreationDate: document.issuedAt,
      ModDate: document.issuedAt,
    },
  })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    pdf.on('error', reject)
  })
  pdf.font('Helvetica-Bold').fontSize(TITLE_SIZE).text(lines.title)
  for (const section of lines.sections) {
    pdf.moveDown(0.8)
    if (section.heading !== null) {
      pdf.font('Helvetica-Bold').fontSize(HEADING_SIZE).text(section.heading)
    }
    pdf.font('Helvetica').fontSize(BODY_SIZE)
    for (const line of section.lines) pdf.text(line)
  }
  pdf.end()
  return done
}
