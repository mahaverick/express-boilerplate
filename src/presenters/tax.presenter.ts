/**
 * @file A workspace's tax details and tax documents as the owner and staff
 * routes answer them. Dates go out as `Date`s, which the JSON response
 * writes as ISO strings.
 */
import type { GstState, TaxDocumentType } from '@/constants/gst.constants'
import type { TaxDocumentRecord, TenantTaxDetailsRecord } from '@/database/models/tax.model'
import type { TaxDocumentReferences } from '@/repositories/tax.repository'
import type { TaxDocumentReference } from '@/types/tax'
import { stateOf, type TaxAmounts } from '@/utilities/gst.utilities'

/**
 * A workspace's tax details: what its invoices print, and the version a
 * PATCH sends back.
 */
export interface TaxDetailsView {
  gstin: string | null
  legalName: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  pincode: string | null
  state: GstState
  isSez: boolean
  version: number
  updatedAt: Date
}

/**
 * Present a stored tax details row.
 * @param row - The row.
 * @returns The view. A state code no longer in the table (written before it was retired) is shown under its code.
 */
export function presentTaxDetails(row: TenantTaxDetailsRecord): TaxDetailsView {
  return {
    gstin: row.gstin,
    legalName: row.legalName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    pincode: row.pincode,
    state: stateOf(row.stateCode) ?? { code: row.stateCode, name: row.stateCode },
    isSez: row.isSez,
    version: row.version,
    updatedAt: row.updatedAt,
  }
}

/**
 * A tax document as a list shows it: its number, date and amounts, the
 * buyer GSTIN and place of supply it was issued with, and its links to the
 * invoice it reduces or the credit notes that reduce it.
 */
export interface TaxDocumentView {
  id: string
  type: TaxDocumentType
  number: string
  financialYear: string
  issuedAt: Date
  amounts: TaxAmounts
  supply: 'intra' | 'inter'
  placeOfSupply: GstState
  /**
   * The GSTIN the document was issued to, not today's.
   */
  buyerGstin: string | null
  /**
   * For a credit note, the invoice it reduces; null for an invoice.
   */
  invoice: TaxDocumentReference | null
  /**
   * For an invoice, its credit notes oldest first; empty for a credit note.
   */
  creditNotes: TaxDocumentReference[]
  /**
   * For an invoice, what its credit notes total, manual ones included; 0 for a credit note.
   */
  creditedMinor: number
  noTaxReduction: boolean
  /**
   * A credit note's reason; null for an invoice.
   */
  reason: string | null
  paymentId: string | null
  refundId: string | null
}

/**
 * Present a stored tax document with its links.
 * @param document - The row.
 * @param references - The links `listRefsFor` read for the page it is on.
 * @returns The view.
 */
export function presentTaxDocument(
  document: TaxDocumentRecord,
  references: TaxDocumentReferences
): TaxDocumentView {
  const isInvoice = document.type === 'invoice'
  return {
    id: document.id,
    type: document.type,
    number: document.number,
    financialYear: document.financialYear,
    issuedAt: document.issuedAt,
    amounts: {
      totalMinor: document.totalMinor,
      taxableMinor: document.taxableMinor,
      cgstMinor: document.cgstMinor,
      sgstMinor: document.sgstMinor,
      igstMinor: document.igstMinor,
      ratePercent: document.snapshot.amounts.ratePercent,
    },
    supply: document.supply,
    placeOfSupply: document.snapshot.placeOfSupply,
    buyerGstin: document.buyerGstin,
    invoice: isInvoice ? null : (references.originals.get(document.id) ?? null),
    creditNotes: isInvoice ? (references.creditNotes.get(document.id) ?? []) : [],
    creditedMinor: isInvoice ? (references.credited.get(document.id) ?? 0) : 0,
    noTaxReduction: document.noTaxReduction,
    reason: isInvoice ? null : document.reason,
    paymentId: document.paymentId,
    refundId: document.refundId,
  }
}
