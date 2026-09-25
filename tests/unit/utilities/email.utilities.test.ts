// tests/unit/utilities/email.utilities.test.ts
import { describe, expect, it } from 'vitest'
import { emailDomain } from '@/utilities/email.utilities'

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
