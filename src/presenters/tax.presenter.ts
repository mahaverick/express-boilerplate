/**
 * @file A workspace's tax details as the owner and staff routes answer
 * them. Dates go out as `Date`s, which the JSON response writes as ISO
 * strings.
 */
import type { GstState } from '@/constants/gst.constants'
import type { TenantTaxDetailsRecord } from '@/database/models/tax.model'
import { stateOf } from '@/utilities/gst.utilities'

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
