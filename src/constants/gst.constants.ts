/**
 * @file Fixed values for GST tax documents: the state table that GSTINs and
 * places of supply use, the tax rate, and the numbering and timing limits.
 */

/** One state or territory a GSTIN or a place of supply can name. */
interface GstState {
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

/** The longest document number rule 46 allows, in characters. */
export const TAX_DOCUMENT_NUMBER_MAX_LENGTH = 16

/** The fewest digits a document's serial number is padded to. */
export const TAX_NUMBER_MIN_DIGITS = 5

/** An invoice issued more than this many days after payment is late. */
export const LATE_INVOICE_DAYS = 30
