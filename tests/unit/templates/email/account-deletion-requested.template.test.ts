/**
 * @file The account deletion receipt: the due date and the support address
 * in both parts, escaping in the HTML part only, and tracking metadata that
 * never resends.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY,
  ACCOUNT_DELETION_REQUESTED_TEMPLATE_META,
  renderAccountDeletionRequestedTemplate,
  type AccountDeletionRequestedVariables,
} from '@/templates/email/account-deletion-requested.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: AccountDeletionRequestedVariables = {
  firstName: 'Ada',
  appName: 'Acme',
  dueAt: '15:42 UTC on 3 December 2026',
  supportEmail: 'support@example.test',
}

describe('renderAccountDeletionRequestedTemplate', () => {
  it('renders the exact subject and text', () => {
    const rendered = renderAccountDeletionRequestedTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY)
    expect(rendered.subject).toBe('We received your request to delete your account')
    expect(rendered.text).toBe(
      [
        'Hi Ada,',
        '',
        "We received your request to delete your Acme account. We'll delete it by 15:42 UTC on 3 December 2026.",
        '',
        'You can keep using your account until then.',
        '',
        "If you didn't ask for this, or you want to keep your account, write to support@example.test before then.",
        '',
        '— The Acme team',
      ].join('\n')
    )
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderAccountDeletionRequestedTemplate({
      ...VARIABLES,
      firstName: '<b>Ada</b>',
    })

    expect(rendered.html).toContain('Hi &lt;b&gt;Ada&lt;/b&gt;,')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.html).toContain('href="mailto:support@example.test"')
    expect(rendered.text).toContain('Hi <b>Ada</b>,')
  })

  it('has senderClass general, stores every variable and never resends', () => {
    expect(ACCOUNT_DELETION_REQUESTED_TEMPLATE_META).toEqual({
      senderClass: 'general',
      previewVariables: ['firstName', 'appName', 'dueAt', 'supportEmail'],
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'dueAt')
    )

    expect(() =>
      renderAccountDeletionRequestedTemplate(partial as AccountDeletionRequestedVariables)
    ).toThrow(/dueAt/)
  })
})
