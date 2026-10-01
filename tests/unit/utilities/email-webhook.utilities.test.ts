import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isSameSignature,
  normalizedMessageIdHeader,
  upperSnakeDetail,
} from '@/utilities/email-webhook.utilities'

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

describe('upperSnakeDetail', () => {
  it.each([
    ['MessageRejected', 'MESSAGE_REJECTED'],
    ['OnAccountSuppressionList', 'ON_ACCOUNT_SUPPRESSION_LIST'],
    ['General', 'GENERAL'],
    ['NoEmail', 'NO_EMAIL'],
    ['SMTPError', 'SMTP_ERROR'],
    ['mailbox full', 'MAILBOX_FULL'],
    ['  Content-Rejected ', 'CONTENT_REJECTED'],
    ['Error5xx', 'ERROR5XX'],
  ])('turns %j into %s', (value, expected) => {
    expect(upperSnakeDetail(value)).toBe(expected)
  })

  it.each([undefined, 7, '', '---', '5xx', 'A'.repeat(33)])('has no detail for %j', (value) => {
    expect(upperSnakeDetail(value)).toBeUndefined()
  })

  it('drops a token-shaped value: 64 hex is too wide, 32 hex is an all-hex run', () => {
    const token = randomBytes(32).toString('hex')
    expect(upperSnakeDetail(token)).toBeUndefined()
    expect(upperSnakeDetail(token.slice(0, 32).replace(/^\d/, 'a'))).toBeUndefined()
  })
})
