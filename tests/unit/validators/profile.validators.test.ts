// tests/unit/validators/profile.validators.test.ts
import { describe, expect, it } from 'vitest'
import { updateProfileSchema } from '@/validators/profile.validators'

describe('updateProfileSchema', () => {
  it.each(['\u{0}', '\u{1B}', '\u{85}', '\u{202E}'])(
    'rejects %j in firstName and lastName',
    (char) => {
      expect(updateProfileSchema.safeParse({ firstName: `Jo${char}hn` }).success).toBe(false)
      expect(updateProfileSchema.safeParse({ lastName: `Do${char}e` }).success).toBe(false)
    }
  )

  it('accepts an accented name', () => {
    expect(updateProfileSchema.safeParse({ firstName: 'Zoë' }).success).toBe(true)
  })
})
