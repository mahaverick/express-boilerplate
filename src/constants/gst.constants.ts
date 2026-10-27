/**
 * @file Fixed values for GST tax documents: the state table that GSTINs and
 * places of supply use, the tax rate, and the numbering and timing limits.
 */

/** One state or territory a GSTIN or a place of supply can name. */
export interface GstState {
  code: string
  name: string
}

/**
 * The 37 selectable states and territories in code order. Codes 25 and 28 are
 * retired and 99 is not a place of supply, so none of them is listed.
 */
export const GST_STATES: readonly GstState[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
]

/** State codes that no longer exist (Daman and Diu, Andhra Pradesh before 2014). */
export const GST_RETIRED_STATE_CODES = ['25', '28'] as const

/** The GST rate on a software subscription, in percent. */
export const GST_RATE_PERCENT = 18

/** The two kinds of tax document. */
export const TAX_DOCUMENT_TYPES = ['invoice', 'credit_note'] as const

/** One of the tax document types. */
export type TaxDocumentType = (typeof TAX_DOCUMENT_TYPES)[number]

/**
 * Where an invoice row stands for tax: its tax invoice is issued, its
 * payment is held as an SEZ charge, the next tax run will invoice it, or it
 * gets no tax invoice at all.
 */
export type TaxStatus = 'issued' | 'held' | 'pending' | 'not_applicable'

/** The longest document number rule 46 allows, in characters. */
export const TAX_DOCUMENT_NUMBER_MAX_LENGTH = 16

/** The fewest digits a document's serial number is padded to. */
export const TAX_NUMBER_MIN_DIGITS = 5

/** An invoice issued more than this many days after payment is late. */
export const LATE_INVOICE_DAYS = 30

/**
 * The part a subscription has played for its workspace: the `held` one it was
 * billed on, a refunded `duplicate`, or one left behind by a `late_switch`.
 */
export const TAX_SUBSCRIPTION_ROLES = ['held', 'duplicate', 'late_switch'] as const

/** One of the subscription roles. */
export type TaxSubscriptionRole = (typeof TAX_SUBSCRIPTION_ROLES)[number]

/**
 * A tax run lists the refunds of an invoiced payment that is not fully
 * credited only while it was paid within this many days: Razorpay refuses a
 * normal refund after six months. A payment named as a hint is always read.
 */
export const TAX_REFUND_LOOKBACK_DAYS = 200

/** The daily refund sweep reads refunds created in this many past days. */
export const TAX_REFUND_SWEEP_DAYS = 3

/** The most tracked subscriptions one tax run reads charges for. */
export const TAX_MAX_TRACKED_SUBSCRIPTIONS = 50

/**
 * The tax details fields a PATCH may send, in the order an audit entry
 * lists the changed ones.
 */
export const TAX_DETAIL_FIELDS = [
  'gstin',
  'legalName',
  'addressLine1',
  'addressLine2',
  'city',
  'pincode',
  'stateCode',
  'isSez',
] as const

/** One of the tax details fields. */
export type TaxDetailField = (typeof TAX_DETAIL_FIELDS)[number]
