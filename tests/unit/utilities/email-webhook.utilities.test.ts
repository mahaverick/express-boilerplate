import { describe, expect, it } from 'vitest'
import { isSameSignature, normalizedMessageIdHeader } from '@/utilities/email-webhook.utilities'

describe('isSameSignature', () => {
  it('accepts identical bytes', () => {
    expect(isSameSignature(Buffer.from('abc'), Buffer.from('abc'))).toBe(true)
  })

  it('refuses same-length bytes that differ, and a different length without throwing', () => {
    expect(isSameSignature(Buffer.from('abc'), Buffer.from('abd'))).toBe(false)
    expect(isSameSignature(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false)
    expect(isSameSignature(Buffer.from('abc'), Buffer.alloc(0))).toBe(false)
  })
})

describe('normalizedMessageIdHeader', () => {
  it('keeps a bracketed header, trimmed', () => {
    expect(normalizedMessageIdHeader('  <0192-abc@mail.example.test>\n')).toBe(
      '<0192-abc@mail.example.test>'
    )
  })

  it('adds the brackets a provider left off', () => {
    expect(normalizedMessageIdHeader('0192-abc@mail.example.test')).toBe(
      '<0192-abc@mail.example.test>'
    )
  })

  it.each([undefined, 42, '', ' '.repeat(3), '<>'])('has no header for %j', (value) => {
    expect(normalizedMessageIdHeader(value)).toBeUndefined()
  })

  it('refuses a header wider than the 255-character column', () => {
    expect(normalizedMessageIdHeader(`<${'a'.repeat(242)}@example.test>`)).toBeUndefined()
    expect(normalizedMessageIdHeader(`<${'a'.repeat(240)}@x.test>`)).toHaveLength(249)
  })
})
