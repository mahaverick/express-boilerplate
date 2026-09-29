import { describe, expect, it } from 'vitest'
import { forgotPasswordSchema, registerSchema } from '@/validators/auth.validators'
import { resendVerificationSchema } from '@/validators/verification.validators'

const VALID_REGISTRATION = { email: 'user@example.com', password: 'a-long-enough-password' }

describe('registerSchema', () => {
  it.each(['\u{0}', '\u{1B}', '\u{85}', '\u{202E}'])(
    'rejects %j in firstName and lastName',
    (char) => {
      expect(
        registerSchema.safeParse({ ...VALID_REGISTRATION, firstName: `Jo${char}hn` }).success
      ).toBe(false)
      expect(
        registerSchema.safeParse({ ...VALID_REGISTRATION, lastName: `Do${char}e` }).success
      ).toBe(false)
    }
  )
})

describe('the app field', () => {
  it('defaults to web', () => {
    expect(registerSchema.parse(VALID_REGISTRATION).app).toBe('web')
    expect(forgotPasswordSchema.parse({ email: 'user@example.com' }).app).toBe('web')
    expect(resendVerificationSchema.parse({ email: 'user@example.com' }).app).toBe('web')
  })

  it('accepts apex', () => {
    expect(registerSchema.parse({ ...VALID_REGISTRATION, app: 'apex' }).app).toBe('apex')
  })

  it.each([['https://evil.example'], ['APEX'], [['apex']], [1]])('refuses %j', (value) => {
    expect(registerSchema.safeParse({ ...VALID_REGISTRATION, app: value }).success).toBe(false)
    expect(forgotPasswordSchema.safeParse({ email: 'user@example.com', app: value }).success).toBe(
      false
    )
  })
})
