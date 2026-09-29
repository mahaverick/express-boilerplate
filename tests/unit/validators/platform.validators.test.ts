import { describe, expect, it } from 'vitest'
import { HttpError } from '@/errors/http-error'
import {
  directionField,
  MAX_REASON_LENGTH,
  pageLimitField,
  parseIdParameter,
  platformTenantSearchSchema,
  reasonBodySchema,
  reasonSchema,
  searchQueryField,
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

describe('directionField', () => {
  it('defaults to next', () => {
    expect(directionField.parse(undefined)).toBe('next')
  })

  it('accepts prev and refuses anything else', () => {
    expect(directionField.parse('prev')).toBe('prev')
    expect(directionField.safeParse('back').success).toBe(false)
  })
})

describe('parseIdParameter', () => {
  it('returns a uuid unchanged', () => {
    const id = '0192f0c1-7a3e-7c3b-8a55-2f1f0d6c9e11'
    expect(parseIdParameter(id, 'User not found')).toBe(id)
  })

  it.each([undefined, '', 'not-a-uuid', '1', ['0192f0c1-7a3e-7c3b-8a55-2f1f0d6c9e11']])(
    'answers 404 with the given message for %j',
    (raw) => {
      expect(() => parseIdParameter(raw, 'Tenant not found')).toThrow(HttpError)
      try {
        parseIdParameter(raw, 'Tenant not found')
      } catch (error) {
        expect((error as HttpError).statusCode).toBe(404)
        expect((error as HttpError).message).toBe('Tenant not found')
      }
    }
  )
})

describe('searchQueryField and pageLimitField', () => {
  it('trims q and refuses whitespace alone, over 100 characters, or a NUL', () => {
    expect(searchQueryField.parse('  acme ')).toBe('acme')
    expect(searchQueryField.safeParse(' '.repeat(3)).success).toBe(false)
    expect(searchQueryField.safeParse('x'.repeat(101)).success).toBe(false)
    expect(searchQueryField.safeParse('a\0b').success).toBe(false)
  })

  it('coerces limit, defaults it to 20 and caps it at 50', () => {
    expect(pageLimitField.parse(undefined)).toBe(20)
    expect(pageLimitField.parse('7')).toBe(7)
    expect(pageLimitField.safeParse('51').success).toBe(false)
    expect(pageLimitField.safeParse('0').success).toBe(false)
  })

  it('parses the tenant search query with the default direction and limit', () => {
    expect(platformTenantSearchSchema.parse({ q: ' acme ' })).toEqual({
      q: 'acme',
      direction: 'next',
      limit: 20,
    })
    expect(platformTenantSearchSchema.safeParse({ q: '  ' }).success).toBe(false)
  })
})
