/**
 * @file The staff alert for an account deletion request due within five
 * days: the due date in both parts, worded as past due once it is overdue,
 * the same summary as the in-app notice,
 * escaping in the HTML part only, and tracking metadata that never resends.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY,
  ACCOUNT_DELETION_DUE_SOON_TEMPLATE_META,
  ACCOUNT_DELETION_DUE_SOON_TITLE,
  accountDeletionDueSoonSummary,
  renderAccountDeletionDueSoonTemplate,
  type AccountDeletionDueSoonVariables,
} from '@/templates/email/account-deletion-due-soon.template'

/**
 * A complete variables object; tests override one field at a time.
 */
const VARIABLES: AccountDeletionDueSoonVariables = {
  firstName: 'Ada',
  appName: 'Acme',
  dueAt: '15:42 UTC on 3 December 2026',
  dueState: 'upcoming',
}

describe('renderAccountDeletionDueSoonTemplate', () => {
  it('renders the exact subject and text', () => {
    const rendered = renderAccountDeletionDueSoonTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Account deletion due within 5 days')
    expect(rendered.subject).toBe(ACCOUNT_DELETION_DUE_SOON_TITLE)
    expect(rendered.text).toBe(
      [
        'Hi Ada,',
        '',
        "A customer's account deletion is due by 15:42 UTC on 3 December 2026. Complete it in Deletion requests before then.",
        '',
        'You are receiving this because you are a platform owner or admin. Find the request in Apex.',
        '',
        '— The Acme team',
      ].join('\n')
    )
    expect(rendered.text).toContain(accountDeletionDueSoonSummary(VARIABLES.dueAt, 'upcoming'))
  })

  it('says an overdue deletion was due, and to complete it now', () => {
    const rendered = renderAccountDeletionDueSoonTemplate({ ...VARIABLES, dueState: 'overdue' })
    const overdue =
      "A customer's account deletion was due by 15:42 UTC on 3 December 2026. Complete it in Deletion requests now."

    expect(accountDeletionDueSoonSummary(VARIABLES.dueAt, 'overdue')).toBe(overdue)
    expect(rendered.text).toContain(overdue)
    expect(rendered.html).toContain(overdue.replace("'", '&#39;'))
    expect(rendered.text).not.toContain('before then')
  })

  it('escapes the variables in the HTML part only', () => {
    const rendered = renderAccountDeletionDueSoonTemplate({ ...VARIABLES, firstName: '<b>Ada</b>' })

    expect(rendered.html).toContain('Hi &lt;b&gt;Ada&lt;/b&gt;,')
    expect(rendered.html).not.toContain('<b>Ada</b>')
    expect(rendered.text).toContain('Hi <b>Ada</b>,')
  })

  it('has senderClass general, stores every variable and never resends', () => {
    expect(ACCOUNT_DELETION_DUE_SOON_TEMPLATE_META).toEqual({
      senderClass: 'general',
      previewVariables: ['firstName', 'appName', 'dueAt', 'dueState'],
      resendAction: null,
    })
  })

  it('refuses to render with a variable missing', () => {
    const partial = Object.fromEntries(
      Object.entries(VARIABLES).filter(([name]) => name !== 'dueAt')
    )

    expect(() =>
      renderAccountDeletionDueSoonTemplate(partial as AccountDeletionDueSoonVariables)
    ).toThrow(/dueAt/)
  })
})
