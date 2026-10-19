import { describe, expect, it } from 'vitest'
import { MIN_PASSWORD_LENGTH } from '@/constants/auth.constants'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@/validators/auth.validators'
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

describe('the password length floor', () => {
  const SHORT = 'a'.repeat(14)
  const LONG_ENOUGH = 'a'.repeat(15)

  it('is 15 characters, the NIST SP 800-63B rev 4 single-factor minimum', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(15)
  })

  it.each([
    [
      'registerSchema',
      (password: string) => registerSchema.safeParse({ email: 'user@example.com', password }),
    ],
    [
      'resetPasswordSchema',
      (password: string) => resetPasswordSchema.safeParse({ token: 't', password }),
    ],
    [
      'changePasswordSchema',
      (password: string) =>
        changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: password }),
    ],
  ])('%s refuses 14 characters and accepts 15', (_name, parse) => {
    const refused = parse(SHORT)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).toBe('Password must be at least 15 characters long.')
    expect(parse(LONG_ENOUGH).success).toBe(true)
  })

  // NIST counts each Unicode code point as one character; an emoji is two UTF-16 code units. zod's string `.min` counts code points.
  it.each([
    ['8 emoji', '\u{1F600}'.repeat(8), false],
    ['15 emoji', '\u{1F600}'.repeat(15), true],
    ['15 ASCII characters', 'a'.repeat(15), true],
  ])('counts the floor in code points: %s', (_name, password, isAccepted) => {
    expect(registerSchema.safeParse({ email: 'user@example.com', password }).success).toBe(
      isAccepted
    )
  })

  // A password set under an older, shorter floor must still be accepted where it is verified, not set.
  it('leaves passwords that are verified, not set, without a floor', () => {
    expect(loginSchema.safeParse({ email: 'user@example.com', password: 'short' }).success).toBe(
      true
    )
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'short', newPassword: LONG_ENOUGH }).success
    ).toBe(true)
  })
})
