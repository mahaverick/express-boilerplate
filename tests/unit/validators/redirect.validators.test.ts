/**
 * @file `redirectPathSchema`: a same-origin path, query and fragment pass
 * byte for byte; anything that could leave the frontend's origin, or carries
 * a control character, fails.
 */
import { describe, expect, it } from 'vite-plus/test'
import { redirectPathSchema } from '@/validators/redirect.validators'

describe('redirect validation', () => {
  it.each([
    '/tenants/acme/members?tenant=acme&tab=2#x',
    '/',
    '/a',
    '/settings/profile',
    '/%2F%2Fevil.test',
    `/${'x'.repeat(2047)}`,
  ])('passes %s unchanged', (value) => {
    expect(redirectPathSchema.parse(value)).toBe(value)
  })

  it.each([
    ['a protocol-relative URL', '//evil.test'],
    ['a backslash after the slash', String.raw`/\evil.test`],
    ['a backslash later in the path', String.raw`/a\b`],
    ['an absolute URL', 'https://evil.test'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a newline', '/a\nb'],
    ['a tab', '/a\tb'],
    ['a NUL', '/a\u{0}b'],
    ['a DEL', '/a\u{7F}b'],
    ['an empty string', ''],
    ['a relative path', 'a/b'],
    ['a value of 2049 characters', `/${'x'.repeat(2048)}`],
  ])('fails %s', (_label, value) => {
    expect(redirectPathSchema.safeParse(value).success).toBe(false)
  })

  it('fails a value that is not a string', () => {
    expect(redirectPathSchema.safeParse(42).success).toBe(false)
  })
})
