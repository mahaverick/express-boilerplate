import { describe, expect, it } from 'vite-plus/test'
import { RESERVED_SLUGS } from '@/constants/tenant.constants'
import {
  invitationListSchema,
  isLocaleTag,
  isSlugShaped,
  isTimeZoneName,
  memberListSchema,
  myTenantListSchema,
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

describe('isTimeZoneName', () => {
  it.each([
    'UTC',
    'Europe/Paris',
    'Etc/GMT+5',
    'America/Argentina/Buenos_Aires',
    'europe/paris',
    '+0530',
  ])('accepts %s', (zone) => {
    expect(isTimeZoneName(zone)).toBe(true)
  })

  it.each(['Not/AZone', '+05:30', 'Etc/\u{202E}gnp', 'UTC X', '', 'a'.repeat(10_000)])(
    'refuses %j',
    (zone) => {
      expect(isTimeZoneName(zone)).toBe(false)
    }
  )
})

describe('isLocaleTag', () => {
  it.each(['en', 'fr', 'en-US', 'zh-Hant-TW', 'pt-BR'])('accepts %s', (tag) => {
    expect(isLocaleTag(tag)).toBe(true)
  })

  it.each(['en_US', 'x-private', 'i-klingon', 'e', 'en-', 'en\u{7}'])('refuses %j', (tag) => {
    expect(isLocaleTag(tag)).toBe(false)
  })
})

describe('the tenant list schemas', () => {
  it('sort members by name, invitations newest first and my tenants by name, unless asked', () => {
    expect(memberListSchema.parse({}).params.sort).toBe('name')
    expect(invitationListSchema.parse({}).params.sort).toBe('-created')
    expect(myTenantListSchema.parse({}).params.sort).toBe('name')
  })

  it('take a comma list of roles', () => {
    expect(memberListSchema.parse({ role: 'viewer,owner' }).filters.role).toEqual([
      'owner',
      'viewer',
    ])
    expect(memberListSchema.safeParse({ role: 'superuser' }).success).toBe(false)
  })
})
