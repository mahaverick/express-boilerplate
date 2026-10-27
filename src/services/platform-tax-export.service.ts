/**
 * @file The staff tax export (`GET /platform/billing/tax-export`): every
 * tax document issued in a month or a financial-year quarter, by IST issue
 * date, as a zip of GSTR-1 CSVs, purged workspaces' documents included.
 * `buildGstr1Csvs` is pure; `exportTaxPeriod` reads, zips and audits.
 *
 * A credit note counts as B2B or B2C by its invoice's buyer. A late credit
 * note (issued after the s.34(2) deadline) reduces no tax, so it is listed
 * only in `late-credit-notes.csv` and never subtracted, though `docs.csv`
 * still counts it as issued. Every text cell goes through `csvCell`, whose
 * formula guard keeps a buyer name such as `=HYPERLINK(…)` inert; amounts
 * are written by `rupees` and skip it, so a negative B2C summary stays a
 * number.
 *
 * Scale: the export loads the period's full document rows (snapshots
 * included) and builds the CSVs and the zip in memory. That suits a quarter
 * of a few thousand documents, a few megabytes. Far beyond that, select only
 * the exported columns and stream the zip.
 */
import { strToU8, zipSync, type Zippable } from 'fflate'
import { gstSellerConfig } from '@/configs/billing.config'
import { TAX_EXPORT_PERIOD_MESSAGE } from '@/constants/billing.constants'
import {
  GST_EXPORT_FILES,
  GST_EXPORT_HEADERS,
  GST_EXPORT_MONTHS,
  GST_EXPORT_VALUES as V,
  type GstExportFile,
} from '@/constants/gst-export.constants'
import { GST_RATE_PERCENT } from '@/constants/gst.constants'
import { HttpError } from '@/errors/http-error'
import { notFoundError } from '@/errors/not-found-errors'
import { PlatformTaxRepository, type ExportDocument } from '@/repositories/platform-tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { record } from '@/services/audit.service'
import { withTransaction } from '@/services/database.service'
import type { Actor } from '@/types/actor'
import { exportPeriodRange, istDate } from '@/utilities/gst.utilities'
import { VALIDATION_FAILED_MESSAGE } from '@/validators/parse.validators'

const platformTaxRepository = new PlatformTaxRepository()
const tenantRepository = new TenantRepository()

const RATE = String(GST_RATE_PERCENT)

/**
 * Amounts summed for one SAC summary row, in paise.
 */
interface HsnTotals {
  total: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
}

/**
 * Write one CSV cell. A value starting with `=`, `+`, `-`, `@`, a tab or a
 * carriage return gets a leading `'`, so a spreadsheet reads it as text and
 * never as a formula. A value holding a comma, a quote or a line break is
 * quoted, its quotes doubled.
 * @param value - The cell's text.
 * @returns The cell as written.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

/**
 * Write paise as rupees with two decimals, in integers so no float rounds it.
 * @param minor - The amount in paise; may be negative.
 * @returns Such as `846.61` or `-423.73`.
 */
function rupees(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * Write an instant as its IST day, as `27-Oct-2026`.
 * @param at - The instant.
 * @returns The date as the GST tool reads it.
 */
function toolDate(at: Date): string {
  const [year, month, day] = istDate(at).split('-')
  return `${day}-${GST_EXPORT_MONTHS[Number(month) - 1]}-${year}`
}

/**
 * A document's place of supply as printed, such as `29-Karnataka`.
 * @param document - The document.
 * @returns The cell.
 */
function placeOfSupply(document: ExportDocument): string {
  const { code, name } = document.snapshot.placeOfSupply
  return csvCell(`${code}-${name}`)
}

/**
 * The buyer GSTIN that decides B2B or B2C: an invoice's own, a credit
 * note's invoice's.
 * @param document - The document.
 * @returns The GSTIN, or null for an unregistered buyer.
 */
function classifyingGstin(document: ExportDocument): string | null {
  if (document.type === 'invoice') return document.buyerGstin
  return document.original === null ? document.buyerGstin : document.original.buyerGstin
}

/**
 * Join cells into one CRLF-terminated line.
 * @param cells - The cells, already written.
 * @returns The line.
 */
function line(cells: readonly string[]): string {
  return `${cells.join(',')}\r\n`
}

/**
 * A credit note's original invoice number and IST date cells.
 * @param document - The credit note.
 * @returns The two cells, empty when the invoice is unknown.
 */
function originalCells(document: ExportDocument): [string, string] {
  if (document.original === null) return ['', '']
  return [csvCell(document.original.number), toolDate(document.original.issuedAt)]
}

/**
 * Add a document's amounts to its SAC's totals, or take a credit note's away.
 * @param totals - The running totals by SAC.
 * @param document - The document.
 */
function addToHsn(totals: Map<string, HsnTotals>, document: ExportDocument): void {
  const sign = document.type === 'invoice' ? 1 : -1
  const sac = document.snapshot.sacCode
  const row = totals.get(sac) ?? { total: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 }
  row.total += sign * document.totalMinor
  row.taxable += sign * document.taxableMinor
  row.igst += sign * document.igstMinor
  row.cgst += sign * document.cgstMinor
  row.sgst += sign * document.sgstMinor
  totals.set(sac, row)
}

/**
 * The SAC summary rows, in SAC order.
 * @param totals - The totals by SAC.
 * @returns The lines.
 */
function hsnLines(totals: Map<string, HsnTotals>): string[] {
  return [...totals.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([sac, row]) =>
      line([
        csvCell(sac),
        V.hsnDescription,
        V.hsnUqc,
        V.hsnQuantity,
        rupees(row.total),
        RATE,
        rupees(row.taxable),
        rupees(row.igst),
        rupees(row.cgst),
        rupees(row.sgst),
        V.zeroAmount,
      ])
    )
}

/**
 * The serial number at the end of a document number, such as 1 for `INV/26-27/00001`.
 * @param document - The document.
 * @returns The serial.
 */
function serial(document: ExportDocument): number {
  return Number(document.number.slice(document.number.lastIndexOf('/') + 1))
}

/**
 * The document series rows: one per type and number prefix, invoices first,
 * from the lowest serial to the highest, compared as numbers.
 * @param documents - Every document in the period, late notes included.
 * @returns The lines.
 */
function seriesLines(documents: readonly ExportDocument[]): string[] {
  const series = new Map<
    string,
    { type: ExportDocument['type']; from: ExportDocument; to: ExportDocument; count: number }
  >()
  for (const document of documents) {
    // Invoices sort first: 0 before 1.
    const key = `${document.type === 'invoice' ? 0 : 1}|${document.number.slice(0, document.number.lastIndexOf('/'))}`
    const entry = series.get(key)
    if (entry === undefined) {
      series.set(key, { type: document.type, from: document, to: document, count: 1 })
      continue
    }
    if (serial(document) < serial(entry.from)) entry.from = document
    if (serial(document) > serial(entry.to)) entry.to = document
    entry.count += 1
  }
  return [...series.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) =>
      line([
        entry.type === 'invoice' ? V.invoiceSeries : V.creditNoteSeries,
        csvCell(entry.from.number),
        csvCell(entry.to.number),
        String(entry.count),
        V.cancelled,
      ])
    )
}

/**
 * Build the GSTR-1 CSVs for one period's documents. Pure: the same
 * documents always give the same text.
 * @param documents - The documents issued in the period.
 * @returns Each file's text: UTF-8 without a BOM, CRLF line ends, a header row first.
 */
export function buildGstr1Csvs(
  documents: readonly ExportDocument[]
): Record<GstExportFile, string> {
  const b2b: string[] = []
  const cdnr: string[] = []
  const late: string[] = []
  const b2cs = new Map<string, { cell: string; taxable: number }>()
  const hsnB2b = new Map<string, HsnTotals>()
  const hsnB2c = new Map<string, HsnTotals>()
  for (const document of documents) {
    const gstin = classifyingGstin(document)
    const name = csvCell(document.snapshot.buyer.legalName)
    if (document.type === 'credit_note' && document.noTaxReduction) {
      late.push(
        line([
          csvCell(document.number),
          toolDate(document.issuedAt),
          ...originalCells(document),
          gstin === null ? '' : csvCell(gstin),
          name,
          rupees(document.totalMinor),
          rupees(document.taxableMinor),
          rupees(document.cgstMinor),
          rupees(document.sgstMinor),
          rupees(document.igstMinor),
        ])
      )
      continue
    }
    addToHsn(gstin === null ? hsnB2c : hsnB2b, document)
    if (gstin === null) {
      const code = document.snapshot.placeOfSupply.code
      const sign = document.type === 'invoice' ? 1 : -1
      const entry = b2cs.get(code) ?? { cell: placeOfSupply(document), taxable: 0 }
      entry.taxable += sign * document.taxableMinor
      b2cs.set(code, entry)
    } else if (document.type === 'invoice') {
      b2b.push(
        line([
          csvCell(gstin),
          name,
          csvCell(document.number),
          toolDate(document.issuedAt),
          rupees(document.totalMinor),
          placeOfSupply(document),
          V.reverseCharge,
          '',
          V.b2bInvoiceType,
          '',
          RATE,
          rupees(document.taxableMinor),
          V.zeroAmount,
        ])
      )
    } else {
      cdnr.push(
        line([
          csvCell(gstin),
          name,
          csvCell(document.number),
          toolDate(document.issuedAt),
          V.noteType,
          placeOfSupply(document),
          V.reverseCharge,
          V.noteSupplyType,
          rupees(document.totalMinor),
          '',
          RATE,
          rupees(document.taxableMinor),
          V.zeroAmount,
          ...originalCells(document),
        ])
      )
    }
  }
  const b2csLines = [...b2cs.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) =>
      line([V.b2csType, entry.cell, '', RATE, rupees(entry.taxable), V.zeroAmount, ''])
    )
  const bodies: Record<GstExportFile, string[]> = {
    'b2b.csv': b2b,
    'b2cs.csv': b2csLines,
    'cdnr.csv': cdnr,
    'hsn-b2b.csv': hsnLines(hsnB2b),
    'hsn-b2c.csv': hsnLines(hsnB2c),
    'docs.csv': seriesLines(documents),
    'late-credit-notes.csv': late,
  }
  return Object.fromEntries(
    GST_EXPORT_FILES.map((file) => [file, line(GST_EXPORT_HEADERS[file]) + bodies[file].join('')])
  ) as Record<GstExportFile, string>
}

/**
 * Export one period's tax documents as a zip of GSTR-1 CSVs and record the
 * download. The zip's file times are midnight on the period's first IST day,
 * read by the local clock as fflate writes them, so a rebuild of one period
 * gives the same bytes in any server time zone.
 * @param actor - The admin downloading it.
 * @param period - `YYYY-MM`, or `YYYY-Qn` for a quarter of the financial year starting in April of YYYY.
 * @returns The zip's file name and bytes.
 * @throws {HttpError} 400 with a `period` field error for a malformed period; 404 `tax_documents_disabled` while registration is off and no document exists.
 */
export async function exportTaxPeriod(
  actor: Actor,
  period: string
): Promise<{ filename: string; body: Uint8Array }> {
  const range = exportPeriodRange(period)
  if (range === null) {
    throw new HttpError(VALIDATION_FAILED_MESSAGE, 400, undefined, {
      period: [TAX_EXPORT_PERIOD_MESSAGE],
    })
  }
  if (gstSellerConfig() === null && !(await platformTaxRepository.hasAnyDocuments())) {
    throw notFoundError('taxDocumentsDisabled', 'export')
  }
  const documents = await platformTaxRepository.listDocumentsIssuedBetween(range.from, range.to)
  const csvs = buildGstr1Csvs(documents)
  const [year = 1980, month = 1] = istDate(range.from).split('-').map(Number)
  const files: Zippable = Object.fromEntries(
    GST_EXPORT_FILES.map((file) => [file, strToU8(csvs[file])])
  )
  const body = zipSync(files, { mtime: new Date(year, month - 1, 1) })
  await withTransaction(async (tx) => {
    const platform = await tenantRepository.findPlatformTenant(tx)
    if (platform === undefined) throw new HttpError('The platform tenant is missing', 500)
    await record(
      {
        action: 'billing.tax_export_downloaded',
        actor,
        access: 'platform',
        tenantId: platform.id,
        targetId: platform.id,
        metadata: { period: range.label },
      },
      tx
    )
  })
  return { filename: `gstr1-${range.label}.zip`, body }
}
