/**
 * @file Tax document types: the snapshot stored with each document, holding
 * every printed field so a document renders the same after its tenant is gone.
 */
import type { GstState } from '@/constants/gst.constants'
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
