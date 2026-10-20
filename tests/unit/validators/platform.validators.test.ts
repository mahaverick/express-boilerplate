import { describe, expect, it } from 'vitest'
import { NOT_FOUND } from '@/errors/not-found-errors'
import {
  MAX_REASON_LENGTH,
  parseIdParameter,
  platformTenantListSchema,
  platformUserListSchema,
  reasonBodySchema,
  reasonSchema,
} from '@/validators/platform.validators'

describe('reasonSchema', () => {
  it('trims the reason', () => {
    expect(reasonSchema.parse('  Unpaid invoice  ')).toBe('Unpaid invoice')
  })

  it.each(['', ' '.repeat(3), '\n\t'])('refuses %j as empty', (value) => {
    expect(reasonSchema.safeParse(value).success).toBe(false)
  })

  it('accepts exactly MAX_REASON_LENGTH characters and refuses one more', () => {
    expect(MAX_REASON_LENGTH).toBe(500)
    expect(reasonSchema.safeParse('x'.repeat(500)).success).toBe(true)
    expect(reasonSchema.safeParse('x'.repeat(501)).success).toBe(false)
  })

  it('keeps a multi-line reason, normalising CRLF', () => {
    expect(reasonSchema.parse('line one\r\nline two')).toBe('line one\nline two')
  })

  it.each(['\u{0}', '\u{1B}', '\u{202E}', 'a\rb'])('refuses %j', (value) => {
    expect(reasonSchema.safeParse(`Reason ${value}`).success).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(reasonSchema.safeParse(42).success).toBe(false)
  })
})

describe('reasonBodySchema', () => {
  it('accepts { reason }', () => {
    expect(reasonBodySchema.parse({ reason: 'Lost laptop' })).toEqual({ reason: 'Lost laptop' })
  })

  it('refuses a missing reason', () => {
    expect(reasonBodySchema.safeParse({}).success).toBe(false)
  })

  it('refuses an unknown key, so a status field can never ride along', () => {
    expect(reasonBodySchema.safeParse({ reason: 'x', active: false }).success).toBe(false)
  })
})

describe('parseIdParameter', () => {
  it('returns a uuid unchanged', () => {
    const id = '0192f0c1-7a3e-7c3b-8a55-2f1f0d6c9e11'
    expect(parseIdParameter(id, 'user')).toBe(id)
  })

  it.each([undefined, '', 'not-a-uuid', '1', ['0192f0c1-7a3e-7c3b-8a55-2f1f0d6c9e11']])(
    'answers %j with the 404 an unknown id of that kind answers',
    (raw) => {
      expect(() => parseIdParameter(raw, 'platformTenant')).toThrow(
        expect.objectContaining({
          statusCode: 404,
          code: NOT_FOUND.platformTenant.code,
          message: NOT_FOUND.platformTenant.message,
        })
      )
    }
  )

  it('answers a malformed member id with member_not_found', () => {
    expect(() => parseIdParameter('not-a-uuid', 'member')).toThrow(
      expect.objectContaining({ statusCode: 404, code: 'member_not_found' })
    )
  })
})

describe('platformTenantListSchema', () => {
  it('defaults state to active and suspended and the sort to name', () => {
    expect(platformTenantListSchema.parse({})).toMatchObject({
      params: { sort: 'name' },
      filters: { state: ['active', 'suspended'] },
    })
  })

  it('refuses a state that is not a lifecycle state', () => {
    expect(platformTenantListSchema.safeParse({ state: 'all' }).success).toBe(false)
  })
})

describe('platformUserListSchema', () => {
  it('defaults status to live accounts and the sort to email', () => {
    expect(platformUserListSchema.parse({})).toMatchObject({
      params: { sort: 'email' },
      filters: { status: ['active', 'inactive'] },
    })
  })

  it('parses signedIn as a boolean filter, absent unless given', () => {
    expect(platformUserListSchema.parse({}).filters.signedIn).toBeUndefined()
    expect(platformUserListSchema.parse({ signedIn: 'true' }).filters.signedIn).toBe(true)
    expect(platformUserListSchema.parse({ signedIn: 'false' }).filters.signedIn).toBe(false)
    expect(platformUserListSchema.safeParse({ signedIn: 'maybe' }).success).toBe(false)
  })

  it('keeps verified and signedIn independent', () => {
    expect(
      platformUserListSchema.parse({ verified: 'true', signedIn: 'false' }).filters
    ).toMatchObject({ verified: true, signedIn: false })
  })

  it('takes -lastSignIn and refuses lastSignIn ascending', () => {
    expect(platformUserListSchema.parse({ sort: '-lastSignIn' }).params.sort).toBe('-lastSignIn')
    expect(platformUserListSchema.safeParse({ sort: 'lastSignIn' }).success).toBe(false)
  })
})
