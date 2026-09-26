// tests/unit/validators/auth.validators.test.ts
import { describe, expect, it } from 'vitest'
import { registerSchema } from '@/validators/auth.validators'

const VALID_REGISTRATION = { email: 'user@example.com', password: 'a-long-enough-password' }

describe('registerSchema', () => {
  it.each(['\u{0}', '\u{1B}', '\u{85}', '‮'])('rejects %j in firstName and lastName', (char) => {
    expect(
      registerSchema.safeParse({ ...VALID_REGISTRATION, firstName: `Jo${char}hn` }).success
    ).toBe(false)
    expect(
      registerSchema.safeParse({ ...VALID_REGISTRATION, lastName: `Do${char}e` }).success
    ).toBe(false)
  })
})
