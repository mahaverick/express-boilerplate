// tests/unit/validators/invitation.validators.test.ts
//
// Pure schema checks: no database, no I/O.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { invitationTokenInputSchema } from '@/validators/invitation.validators'

describe('invitationTokenInputSchema', () => {
  it('accepts a real token: 32 random bytes as base64url', () => {
    const token = randomBytes(32).toString('base64url')

    expect(invitationTokenInputSchema.safeParse({ token }).success).toBe(true)
  })

  it.each([
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['base64 padding', `${'a'.repeat(42)}=`],
    ['a "+" from standard base64', `${'a'.repeat(42)}+`],
    ['a "/" from standard base64', `${'a'.repeat(42)}/`],
    ['a 64-character hex token of another purpose', 'a'.repeat(64)],
  ])('rejects %s', (_label, token) => {
    expect(invitationTokenInputSchema.safeParse({ token }).success).toBe(false)
  })

  it('rejects a token that is not a string', () => {
    const token = randomBytes(32).toString('base64url')

    expect(invitationTokenInputSchema.safeParse({ token: [token] }).success).toBe(false)
    expect(invitationTokenInputSchema.safeParse({}).success).toBe(false)
  })
})
