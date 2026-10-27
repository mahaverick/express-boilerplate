import { describe, expect, it } from 'vitest'
/** @file Pins the GST state table and fixed tax values. */
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

  it('pins the fixed values', () => {
    expect(GST_RETIRED_STATE_CODES).toEqual(['25', '28'])
    expect(GST_RATE_PERCENT).toBe(18)
    const types: readonly TaxDocumentType[] = TAX_DOCUMENT_TYPES
    expect(types).toEqual(['invoice', 'credit_note'])
  })
})
