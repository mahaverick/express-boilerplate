/**
 * @file A workspace's tax details, tax documents and held SEZ charges as the
 * owner and staff routes answer them. Dates go out as `Date`s, which the JSON response
 * writes as ISO strings.
 */
import type { GstState, TaxDocumentType } from '@/constants/gst.constants'
import type {
  TaxDocumentRecord,
  TaxHeldChargeRecord,
  TenantTaxDetailsRecord,
} from '@/database/models/tax.model'
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

/**
 * A staff member or user as staff read them: their id and name (or email).
 */
interface PersonView {
  userId: string
  name: string
}

/**
 * A workspace's tax details as staff read them, with who saved them last.
 */
export interface StaffTaxDetailsView extends TaxDetailsView {
  /**
   * Null when the account is no longer on record.
   */
  updatedBy: PersonView | null
}

/**
 * A tax document on the staff list: the owner's view, whether staff issued
 * it by hand, and who did.
 */
export interface StaffTaxDocumentItem extends TaxDocumentView {
  /**
   * A credit note staff issued by hand, with no refund behind it.
   */
  manual: boolean
  /**
   * Who issued a manual note; null for any other document or a purged account.
   */
  createdBy: PersonView | null
}

/**
 * Present a stored tax document for staff.
 * @param document - The row.
 * @param references - The links `listRefsFor` read for the page it is on.
 * @param createdBy - Who issued it by hand, if anyone still on record.
 * @returns The view.
 */
export function presentStaffTaxDocument(
  document: TaxDocumentRecord,
  references: TaxDocumentReferences,
  createdBy: PersonView | null
): StaffTaxDocumentItem {
  return {
    ...presentTaxDocument(document, references),
    manual: document.type === 'credit_note' && document.refundId === null,
    createdBy,
  }
}

/**
 * An SEZ buyer's charge held for staff to invoice by hand, and its
 * resolution.
 */
export interface TaxHeldChargeView {
  id: string
  paymentId: string
  subscriptionId: string | null
  amountMinor: number
  paidAt: Date
  heldAt: Date
  resolvedAt: Date | null
  /**
   * Null while open, or when the account is no longer on record.
   */
  resolvedBy: PersonView | null
  /**
   * The staff member's note when they resolved it.
   */
  resolution: string | null
}

/**
 * Present a held charge.
 * @param charge - The row.
 * @param resolvedBy - Who resolved it, if anyone still on record.
 * @returns The view.
 */
export function presentHeldCharge(
  charge: TaxHeldChargeRecord,
  resolvedBy: PersonView | null
): TaxHeldChargeView {
  return {
    id: charge.id,
    paymentId: charge.paymentId,
    subscriptionId: charge.subscriptionId,
    amountMinor: charge.amountMinor,
    paidAt: charge.paidAt,
    heldAt: charge.heldAt,
    resolvedAt: charge.resolvedAt,
    resolvedBy,
    resolution: charge.resolution,
  }
}
