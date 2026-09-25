// tests/unit/services/platform.service.test.ts
//
// The pure domain rules auto-join applies. Importing the service does not
// touch Postgres: database.service.ts connects on first query, and nothing
// here queries.
import { describe, expect, it } from 'vitest'
import { isPlatformEmailDomain, parsePlatformEmailDomains } from '@/services/platform.service'

describe('parsePlatformEmailDomains', () => {
  it('returns no domains for an unset value', () => {
    expect(parsePlatformEmailDomains(undefined)).toEqual([])
  })

  it('splits on commas, trims and lowercases each entry', () => {
    expect(parsePlatformEmailDomains(' staff.example.com , Example.ORG')).toEqual([
      'staff.example.com',
      'example.org',
    ])
  })
})

describe('isPlatformEmailDomain', () => {
  const domains = ['staff.example.com']

  it('matches the exact domain, in any case', () => {
    expect(isPlatformEmailDomain('ada@Staff.Example.COM', domains)).toBe(true)
  })

  it('does not match a subdomain', () => {
    expect(isPlatformEmailDomain('ada@eu.staff.example.com', domains)).toBe(false)
  })

  it('does not match a look-alike that merely ends with the domain', () => {
    expect(isPlatformEmailDomain('ada@evilstaff.example.com', domains)).toBe(false)
  })

  it('matches nothing when the list is empty', () => {
    expect(isPlatformEmailDomain('ada@staff.example.com', [])).toBe(false)
  })
})
