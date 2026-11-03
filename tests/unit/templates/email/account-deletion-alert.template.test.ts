/**
 * @file The staff alert for a new account deletion request: the due date in
 * both parts, escaping in the HTML part only, and tracking metadata that
 * never resends.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  ACCOUNT_DELETION_ALERT_TEMPLATE_KEY,
  ACCOUNT_DELETION_ALERT_TEMPLATE_META,
  renderAccountDeletionAlertTemplate,
  type AccountDeletionAlertVariables,
} from '@/templates/email/account-deletion-alert.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: AccountDeletionAlertVariables = {
  firstName: 'Ada',
  appName: 'Acme',
  dueAt: '15:42 UTC on 3 December 2026',
}

describe('renderAccountDeletionAlertTemplate', () => {
  it('renders the exact subject and text', () => {
    const rendered = renderAccountDeletionAlertTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(ACCOUNT_DELETION_ALERT_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Account deletion requested')
    expect(rendered.text).toBe(
      [
        'Hi Ada,',
        '',
        'A customer asked us to delete their account. Complete it in Deletion requests by 15:42 UTC on 3 December 2026.',
        '',
        'You are receiving this because you are a platform admin. Find the request in Apex.',
        '',
        '— The Acme team',
      ].join('\n')
    )
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderAccountDeletionAlertTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('Hi &lt;b&gt;Ada&lt;/b&gt;,')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.text).toContain('Hi <b>Ada</b>,')
  })

  it('has senderClass general, stores every variable and never resends', () => {
    expect(ACCOUNT_DELETION_ALERT_TEMPLATE_META).toEqual({
      senderClass: 'general',
      previewVariables: ['firstName', 'appName', 'dueAt'],
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'dueAt')
    )

    expect(() =>
      renderAccountDeletionAlertTemplate(partial as AccountDeletionAlertVariables)
    ).toThrow(/dueAt/)
  })
})
