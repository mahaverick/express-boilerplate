/**
 * @file Tax document types: the snapshot stored with each document, holding
 * every printed field so a document renders the same after its tenant is
 * gone, and the plan and report of a workspace's tax run.
 */
import type { GstState, TaxStatus } from '@/constants/gst.constants'
import type { ProviderCharge, ProviderInvoice, ProviderRefund } from '@/types/billing'
import type { TaxAmounts } from '@/utilities/gst.utilities'

/**
 * The fields a tax document prints, frozen at issue (version 1).
 */
export interface TaxDocumentSnapshot {
  version: 1
  seller: { legalName: string; addressLines: string[]; gstin: string; state: GstState }
  buyer: {
    legalName: string
    gstin: string | null
    addressLines: string[]
    state: GstState | null
    source: 'tax_details' | 'workspace'
  }
  placeOfSupply: GstState
  supply: 'intra' | 'inter'
  sacCode: string
  description: string
  billingPeriod: { start: string; end: string } | null
  amounts: TaxAmounts
  reference: { paymentId: string | null; refundId: string | null }
  original: { number: string; issuedAt: string } | null
  reason: string | null
}

/**
 * A pointer to a tax document: its id and number.
 */
export interface TaxDocumentReference {
  id: string
  number: string
}

/**
 * What an invoice row shows of its payment's tax: the tax invoice, its
 * credit notes oldest first, and its tax status.
 */
interface InvoiceTaxLinks {
  taxDocument: TaxDocumentReference | null
  creditNotes: TaxDocumentReference[]
  taxStatus: TaxStatus
}

/**
 * A provider invoice with its tax links. Its payment id, used to find them,
 * is dropped: no owner or staff response carries it.
 */
export type LinkedInvoice = Omit<ProviderInvoice, 'paymentId'> & InvoiceTaxLinks

/**
 * One invoice row as an owner reads it: a linked invoice without the
 * subscription it bills, which only staff see.
 */
export type OwnerInvoiceView = Omit<LinkedInvoice, 'subscriptionId'>

/**
 * A paid charge a tax run invoices, with the line it prints and whether it
 * is issued more than 30 days after payment.
 */
export interface PlannedInvoice {
  charge: ProviderCharge
  description: string
  isLate: boolean
}

/**
 * A paid charge of an SEZ buyer a tax run holds instead of invoicing. It
 * keeps its invoice line, in case the buyer stopped being an SEZ unit
 * before the issue and the charge is invoiced after all.
 */
export interface PlannedHold {
  charge: ProviderCharge
  description: string
}

/**
 * A processed refund a tax run credits, or reports as more than what is left.
 */
export interface PlannedCreditNote {
  paymentId: string
  /**
   * The invoice it credits, or null when that invoice is planned in this run.
   */
  invoiceId: string | null
  refund: ProviderRefund
  /**
   * What is left to credit on the invoice before this refund.
   */
  remainingMinor: number
}

/**
 * A processed refund of a held SEZ charge. No credit note follows: staff
 * issue the invoice by hand, so they credit it by hand too, and an alert
 * tells them.
 */
export interface PlannedHeldRefund {
  paymentId: string
  refund: ProviderRefund
}

/**
 * What one tax run will do for a workspace. A charge's credit notes always
 * come after its invoice, and a held charge's refunds are never credited,
 * only reported (`heldRefunds`).
 */
export interface TaxPlan {
  /**
   * Why the run does nothing: registration or payments are off, or the
   * workspace has no billing row; null when it runs.
   */
  skipped: 'registration_off' | 'payments_off' | 'no_row' | null
  invoices: PlannedInvoice[]
  creditNotes: PlannedCreditNote[]
  holds: PlannedHold[]
  overCredits: PlannedCreditNote[]
  heldRefunds: PlannedHeldRefund[]
}

/**
 * What one tax run did: the documents it issued, the charges it held, how
 * many were late and how many refunds were more than what was left to credit.
 */
export interface TaxReconcileReport {
  skipped: TaxPlan['skipped']
  issued: { invoices: number; creditNotes: number }
  held: number
  late: { invoices: number; creditNotes: number }
  overCredits: number
}
