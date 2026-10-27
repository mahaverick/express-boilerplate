/**
 * @file A stored tax details row as the routes answer it: the state named
 * from the table, and a code no longer in it shown under its code.
 */
import { describe, expect, it } from 'vite-plus/test'
import type { TenantTaxDetailsRecord } from '@/database/models/tax.model'
import { presentTaxDetails } from '@/presenters/tax.presenter'

const updatedAt = new Date('2026-10-27T10:00:00.000Z')

/**
 * A stored row with a state code.
 * @param stateCode - The stored code.
 * @returns The row.
 */
function row(stateCode: string): TenantTaxDetailsRecord {
  return {
    tenantId: 'tenant-1',
    gstin: null,
    legalName: 'Acme Traders',
    addressLine1: null,
    addressLine2: null,
    city: null,
    pincode: null,
    stateCode,
    isSez: false,
    updatedBy: 'user-1',
    updatedAt,
    version: 3,
  }
}

describe('presentTaxDetails', () => {
  it('names the state and leaves out the tenant and the saver', () => {
    expect(presentTaxDetails(row('29'))).toStrictEqual({
      gstin: null,
      legalName: 'Acme Traders',
      addressLine1: null,
      addressLine2: null,
      city: null,
      pincode: null,
      state: { code: '29', name: 'Karnataka' },
      isSez: false,
      version: 3,
      updatedAt,
    })
  })

  it('shows a retired state code under its code', () => {
    expect(presentTaxDetails(row('25')).state).toStrictEqual({ code: '25', name: '25' })
  })
})
