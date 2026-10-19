/**
 * @file The shared auth body pieces: the `app` a mailed link or OAuth
 * redirect opens, and the normalised email.
 */
import { describe, expect, it } from 'vitest'
import { emailSchema, frontendAppSchema } from '@/validators/auth.validators'

describe('frontendAppSchema', () => {
  it('defaults to web', () => {
    expect(frontendAppSchema.parse(undefined)).toBe('web')
  })

  it('accepts apex', () => {
    expect(frontendAppSchema.parse('apex')).toBe('apex')
  })

  it.each([['https://evil.example'], ['APEX'], [['apex']], [1]])('refuses %j', (value) => {
    expect(frontendAppSchema.safeParse(value).success).toBe(false)
  })
})

describe('emailSchema', () => {
  it('trims and lowercases before it checks the format', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com')
  })
})
