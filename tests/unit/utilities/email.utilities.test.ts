// tests/unit/utilities/email.utilities.test.ts
import { describe, expect, it } from 'vitest'
import { emailDomain, hostnameDomain } from '@/utilities/email.utilities'

describe('emailDomain', () => {
  it('takes everything after the last @, lowercased', () => {
    expect(emailDomain('"a@b"@Staff.Example.com')).toBe('staff.example.com')
  })

  it('returns undefined when there is no @', () => {
    expect(emailDomain('not-an-address')).toBeUndefined()
  })

  it('returns undefined when nothing follows the last @', () => {
    expect(emailDomain('ada@')).toBeUndefined()
  })
})

describe('hostnameDomain', () => {
  it('returns a dotted hostname, lowercased', () => {
    expect(hostnameDomain('ada@Sub.Example.com')).toBe('sub.example.com')
  })

  it.each([
    ['no @', 'not-an-address'],
    ['a label ending in a hyphen', 'ada@foo-.com'],
    ['a 64-character label', `ada@${'a'.repeat(64)}.com`],
    [
      'a domain over 253 characters',
      `ada@${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.com`,
    ],
    ['a single label', 'ada@localhost'],
  ])('returns undefined for %s', (_label, email) => {
    expect(hostnameDomain(email)).toBeUndefined()
  })
})
