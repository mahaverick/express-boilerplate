/** @file Pins the GST state table and fixed tax values. */
import { describe, expect, it } from 'vitest'
import type { TaxDocumentType } from '@/constants/gst.constants'
import {
  GST_RATE_PERCENT,
  GST_RETIRED_STATE_CODES,
  GST_STATES,
  TAX_DOCUMENT_TYPES,
} from '@/constants/gst.constants'

describe('gst constants', () => {
  it('GST_STATES has 37 rows, unique ascending codes, no 25, 28 or 99, and 97', () => {
    const codes = GST_STATES.map((s) => s.code)
    expect(codes).toHaveLength(37)
    expect(new Set(codes).size).toBe(37)
    const sorted = codes.toSorted()
    expect(codes).toEqual(sorted)
    expect(codes).not.toContain('25')
    expect(codes).not.toContain('28')
    expect(codes).not.toContain('99')
    expect(codes).toContain('97')
    expect(GST_STATES.find((s) => s.code === '26')?.name).toBe(
      'Dadra and Nagar Haveli and Daman and Diu'
    )
  })

  it('pins every row of GST_STATES, written out here rather than copied from the source', () => {
    const expected = [
      ['01', 'Jammu and Kashmir'],
      ['02', 'Himachal Pradesh'],
      ['03', 'Punjab'],
      ['04', 'Chandigarh'],
      ['05', 'Uttarakhand'],
      ['06', 'Haryana'],
      ['07', 'Delhi'],
      ['08', 'Rajasthan'],
      ['09', 'Uttar Pradesh'],
      ['10', 'Bihar'],
      ['11', 'Sikkim'],
      ['12', 'Arunachal Pradesh'],
      ['13', 'Nagaland'],
      ['14', 'Manipur'],
      ['15', 'Mizoram'],
      ['16', 'Tripura'],
      ['17', 'Meghalaya'],
      ['18', 'Assam'],
      ['19', 'West Bengal'],
      ['20', 'Jharkhand'],
      ['21', 'Odisha'],
      ['22', 'Chhattisgarh'],
      ['23', 'Madhya Pradesh'],
      ['24', 'Gujarat'],
      ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
      ['27', 'Maharashtra'],
      ['29', 'Karnataka'],
      ['30', 'Goa'],
      ['31', 'Lakshadweep'],
      ['32', 'Kerala'],
      ['33', 'Tamil Nadu'],
      ['34', 'Puducherry'],
      ['35', 'Andaman and Nicobar Islands'],
      ['36', 'Telangana'],
      ['37', 'Andhra Pradesh'],
      ['38', 'Ladakh'],
      ['97', 'Other Territory'],
    ]
    expect(GST_STATES).toEqual(expected.map(([code, name]) => ({ code, name })))
  })

  it('pins the fixed values', () => {
    expect(GST_RETIRED_STATE_CODES).toEqual(['25', '28'])
    expect(GST_RATE_PERCENT).toBe(18)
    const types: readonly TaxDocumentType[] = TAX_DOCUMENT_TYPES
    expect(types).toEqual(['invoice', 'credit_note'])
  })
})
