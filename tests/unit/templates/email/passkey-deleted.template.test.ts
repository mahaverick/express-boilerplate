/**
 * @file The "passkey deleted" security mail: the provider and time in both
 * parts, escaping in the HTML part only, and tracking metadata that stores
 * no link and never resends.
 */
import { describe, expect, it } from 'vitest'
import type { PasskeySecurityVariables } from '@/templates/email/passkey-created.template'
import {
  PASSKEY_DELETED_TEMPLATE_KEY,
  PASSKEY_DELETED_TEMPLATE_META,
  renderPasskeyDeletedTemplate,
} from '@/templates/email/passkey-deleted.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: PasskeySecurityVariables = {
  firstName: 'Ada',
  providerName: 'iCloud Keychain',
  occurredAt: '15:42 UTC on 20 October 2026',
  settingsUrl:
    'https://app.example.test/settings/account/security?utm_source=email&utm_medium=email',
  appName: 'Acme',
}

describe('renderPasskeyDeletedTemplate', () => {
  it('renders the exact subject and text', () => {
    const rendered = renderPasskeyDeletedTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(PASSKEY_DELETED_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Passkey deleted from your Acme account')
    expect(rendered.text).toBe(
      [
        'Hi Ada,',
        '',
        'You, or someone signed in as you, deleted a passkey (iCloud Keychain) from your Acme account at 15:42 UTC on 20 October 2026.',
        '',
        "If this wasn't you, sign in and check your passkeys in Security settings: https://app.example.test/settings/account/security?utm_source=email&utm_medium=email",
        '',
        '— The Acme team',
      ].join('\n')
    )
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderPasskeyDeletedTemplate({ ...VARIABLES, providerName: '<b>Key</b> & Co' })

    expect(rendered.html).toContain('&lt;b&gt;Key&lt;/b&gt; &amp; Co')
    expect(rendered.html).not.toContain('<b>Key</b>')
    expect(rendered.html).toContain('utm_source=email&amp;utm_medium=email')
    expect(rendered.text).toContain('<b>Key</b> & Co')
  })

  it('has senderClass transactional, stores no …Url variable and never resends', () => {
    expect(PASSKEY_DELETED_TEMPLATE_META).toEqual({
      senderClass: 'transactional',
      previewVariables: ['firstName', 'providerName', 'occurredAt', 'appName'],
      // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'providerName')
    )

    expect(() => renderPasskeyDeletedTemplate(partial as PasskeySecurityVariables)).toThrow(
      /providerName/
    )
  })
})
