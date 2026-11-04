/**
 * @file The account deleted confirmation: the support address in both
 * parts, escaping in the HTML part only, and tracking metadata that never
 * resends.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  ACCOUNT_DELETED_TEMPLATE_KEY,
  ACCOUNT_DELETED_TEMPLATE_META,
  renderAccountDeletedTemplate,
  type AccountDeletedVariables,
} from '@/templates/email/account-deleted.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: AccountDeletedVariables = {
  firstName: 'Ada',
  appName: 'Acme',
  supportEmail: 'support@example.test',
}

describe('renderAccountDeletedTemplate', () => {
  it('renders the exact subject and text', () => {
    const rendered = renderAccountDeletedTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(ACCOUNT_DELETED_TEMPLATE_KEY)
    expect(rendered.subject).toBe('We deleted your account')
    expect(rendered.text).toBe(
      [
        'Hi Ada,',
        '',
        'We deleted your Acme account, as you asked.',
        '',
        'You can no longer sign in to it. If you sign in with this address again, you get a new, empty account.',
        '',
        "If you didn't ask for this, write to support@example.test.",
        '',
        '— The Acme team',
      ].join('\n')
    )
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderAccountDeletedTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('Hi &lt;b&gt;Ada&lt;/b&gt;,')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.html).toContain(
      '<a href="mailto:support@example.test">support@example.test</a>'
    )
    expect(rendered.text).toContain('Hi <b>Ada</b>,')
  })

  it('has senderClass general, stores every variable and never resends', () => {
    expect(ACCOUNT_DELETED_TEMPLATE_META).toEqual({
      senderClass: 'general',
      previewVariables: ['firstName', 'appName', 'supportEmail'],
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'supportEmail')
    )

    expect(() => renderAccountDeletedTemplate(partial as AccountDeletedVariables)).toThrow(
      /supportEmail/
    )
  })
})
