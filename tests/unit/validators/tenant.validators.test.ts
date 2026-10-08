import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS } from '@/constants/tenant.constants'
import {
  isSlugShaped,
  newTenantSchema,
  scanJson,
  slugSchema,
  updateTenantSchema,
} from '@/validators/tenant.validators'

describe('slugSchema', () => {
  it('reserves the seeded platform tenant’s slug', () => {
    expect(RESERVED_SLUGS).toContain('platform')
    expect(slugSchema.safeParse('platform').success).toBe(false)
  })

  it('still accepts an ordinary slug', () => {
    expect(slugSchema.safeParse('platform-team').success).toBe(true)
  })
})

describe('newTenantSchema free-text fields reject control characters and bidi overrides', () => {
  const REJECTED = ['\u{0}', '\u{1B}', '\u{85}', '\u{202E}']

  it.each(REJECTED)('rejects %j in name', (char) => {
    const result = newTenantSchema.safeParse({ name: `Acme${char}Inc`, slug: 'acme' })
    expect(result.success).toBe(false)
  })

  it.each(REJECTED)('rejects %j in logo', (char) => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      logo: `https://example.com/${char}.png`,
    })
    expect(result.success).toBe(false)
  })

  it.each(REJECTED)('rejects %j in website', (char) => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      website: `https://example${char}.com`,
    })
    expect(result.success).toBe(false)
  })

  it.each(REJECTED)('rejects %j in description', (char) => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      description: `A company${char} that does things`,
    })
    expect(result.success).toBe(false)
  })

  it(String.raw`description accepts \n and \t`, () => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      description: 'Line one\nLine two\tindented',
    })
    expect(result.success).toBe(true)
  })

  it(String.raw`description normalises \r\n to \n`, () => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      description: 'Line one\r\nLine two',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.description).toBe('Line one\nLine two')
  })

  it(String.raw`description rejects a lone \r left after CRLF normalisation`, () => {
    const result = newTenantSchema.safeParse({
      name: 'Acme',
      slug: 'acme',
      description: 'Line one\rLine two',
    })
    expect(result.success).toBe(false)
  })

  it('accepts accented and emoji names', () => {
    const result = newTenantSchema.safeParse({ name: 'Zoë 👋', slug: 'zoe' })
    expect(result.success).toBe(true)
  })
})

describe('updateTenantSchema free-text fields', () => {
  it('rejects a control character in a PATCH name too', () => {
    const result = updateTenantSchema.safeParse({ name: 'Acme\u{0}Inc' })
    expect(result.success).toBe(false)
  })

  it('null still clears description (safeText does not run against null)', () => {
    // eslint-disable-next-line unicorn/no-null -- proving the PATCH "clear" contract survives the new refinement
    const result = updateTenantSchema.safeParse({ description: null })
    expect(result.success).toBe(true)
  })
})

describe('isSlugShaped', () => {
  it('accepts a stored slug, including the reserved platform tenant slug', () => {
    expect(isSlugShaped('acme-inc')).toBe(true)
    expect(isSlugShaped('platform')).toBe(true)
  })

  it.each(['a\u{0}b', 'Acme', '-acme', 'acme-', 'a'.repeat(101), ' acme', ''])(
    'refuses %j',
    (value) => {
      expect(isSlugShaped(value)).toBe(false)
    }
  )
})

describe('scanJson', () => {
  it('finds a NUL in a nested key or string value', () => {
    expect(scanJson({ a: [{ b: 'x\u{0}' }] }).hasNul).toBe(true)
    expect(scanJson({ a: { 'b\u{0}': 1 } }).hasNul).toBe(true)
    // eslint-disable-next-line unicorn/no-null -- JSON null, as a request body carries it
    expect(scanJson({ a: ['x', 1, true, null] }).hasNul).toBe(false)
  })

  it('measures nesting depth without recursing', () => {
    expect(scanJson('x').depth).toBe(0)
    expect(scanJson({}).depth).toBe(1)
    expect(scanJson({ a: [{ b: 1 }] }).depth).toBe(3)
    let deep: unknown = {}
    for (let level = 0; level < 100_000; level += 1) deep = { a: deep }
    expect(scanJson(deep).depth).toBe(100_001)
  })
})
