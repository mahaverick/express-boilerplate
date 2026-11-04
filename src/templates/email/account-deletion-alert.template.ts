/**
 * @file The staff alert for a new account deletion request, to every
 * platform owner and admin: a customer asked us to delete their account, and the date
 * to complete it by. It names no customer and carries no token or link; its
 * variables hold no secret.
 */
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
  type EmailTemplateMeta,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS`. `satisfies`, not an
 * annotation, so it keeps the literal type that `MailMessage`'s union
 * narrows on.
 */
export const ACCOUNT_DELETION_ALERT_TEMPLATE_KEY =
  'account_deletion_alert' satisfies EmailTemplateKey

/**
 * The variables `renderAccountDeletionAlertTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface AccountDeletionAlertVariables {
  firstName: string
  appName: string
  /**
   * When the deletion is due, from `formatUtcDateTime`.
   */
  dueAt: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored. Never resent: a second copy would report a
 * request that was not made again.
 */
export const ACCOUNT_DELETION_ALERT_TEMPLATE_META: EmailTemplateMeta<AccountDeletionAlertVariables> =
  {
    senderClass: 'general',
    previewVariables: ['firstName', 'appName', 'dueAt'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountDeletionAlertVariables> = [
  'firstName',
  'appName',
  'dueAt',
]

/**
 * The alert's one-line summary, shared with the in-app notification's body
 * so the two never drift.
 * @param dueAt - When the deletion is due, from `formatUtcDateTime`.
 * @returns The summary.
 */
export function accountDeletionAlertSummary(dueAt: string): string {
  return `A customer asked us to delete their account. Complete it in Deletion requests by ${dueAt}.`
}

/**
 * Render the staff alert: plain-text and HTML parts naming the due date.
 * @param variables - See `AccountDeletionAlertVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderAccountDeletionAlertTemplate(
  variables: AccountDeletionAlertVariables
): RenderedEmail {
  const { firstName, appName, dueAt } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_DELETION_ALERT_TEMPLATE_KEY
  )

  const subject = 'Account deletion requested'
  const summary = accountDeletionAlertSummary(dueAt)
  const why =
    'You are receiving this because you are a platform owner or admin. Find the request in Apex.'

  const text = [`Hi ${firstName},`, '', summary, '', why, '', `— The ${appName} team`].join('\n')

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapeHtmlForEmail(firstName)},</p>
    <p>${escapeHtmlForEmail(summary)}</p>
    <p>${why}</p>
    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return { templateKey: ACCOUNT_DELETION_ALERT_TEMPLATE_KEY, subject, text, html }
}
