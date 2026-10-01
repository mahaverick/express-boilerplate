/**
 * @file Which From address each sender class resolves to, and how a
 * sender's domain is read.
 */
import { describe, expect, it } from 'vitest'
import { senderDomain, senderFor } from '@/utilities/email-sender.utilities'

describe('senderFor', () => {
  const both = { MAIL_FROM: 'hello@example.net', MAIL_FROM_TRANSACTIONAL: 'auth@mail.example.net' }

  it('mails token templates from MAIL_FROM_TRANSACTIONAL', () => {
    expect(senderFor('transactional', both)).toBe('auth@mail.example.net')
  })

  it('mails every other template from MAIL_FROM', () => {
    expect(senderFor('general', both)).toBe('hello@example.net')
  })

  it('falls back to MAIL_FROM when MAIL_FROM_TRANSACTIONAL is unset', () => {
    expect(senderFor('transactional', { MAIL_FROM: 'hello@example.net' })).toBe('hello@example.net')
  })
})

describe('senderDomain', () => {
  it('reads the domain after the last @, lowercased', () => {
    expect(senderDomain('Auth@Mail.Example.NET')).toBe('mail.example.net')
    expect(senderDomain('"a@b"@example.test')).toBe('example.test')
  })
})
