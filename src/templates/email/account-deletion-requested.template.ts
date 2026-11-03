/**
 * @file The account deletion receipt: tells a customer we received their
 * request to delete their account, the date we will have deleted it by, and
 * where to write if they did not ask or want to keep it. It carries no
 * token and no link; its variables hold no secret.
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
export const ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY =
  'account_deletion_requested' satisfies EmailTemplateKey

/**
 * The variables `renderAccountDeletionRequestedTemplate` needs. All are
 * required strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface AccountDeletionRequestedVariables {
  firstName: string
  appName: string
  /**
   * When we will have deleted the account by, from `formatUtcDateTime`.
   */
  dueAt: string
  /**
   * The support address (`supportAddress`, email-sender.utilities.ts).
   */
  supportEmail: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored. Never resent: a second receipt would read as
 * a second request.
 */
export const ACCOUNT_DELETION_REQUESTED_TEMPLATE_META: EmailTemplateMeta<AccountDeletionRequestedVariables> =
  {
    senderClass: 'general',
    previewVariables: ['firstName', 'appName', 'dueAt', 'supportEmail'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountDeletionRequestedVariables> = [
  'firstName',
  'appName',
  'dueAt',
  'supportEmail',
]

/**
 * Render the account deletion receipt: plain-text and HTML parts naming the
 * due date and the support address.
 * @param variables - See `AccountDeletionRequestedVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderAccountDeletionRequestedTemplate(
  variables: AccountDeletionRequestedVariables
): RenderedEmail {
  const { firstName, appName, dueAt, supportEmail } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY
  )

  const subject = 'We received your request to delete your account'
  const received = `We received your request to delete your ${appName} account. We'll delete it by ${dueAt}.`
  const until = 'You can keep using your account until then.'

  const text = [
    `Hi ${firstName},`,
    '',
    received,
    '',
    until,
    '',
    `If you didn't ask for this, or you want to keep your account, write to ${supportEmail} before then.`,
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedSupportEmail = escapeHtmlForEmail(supportEmail)
  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapeHtmlForEmail(firstName)},</p>
    <p>${escapeHtmlForEmail(received)}</p>
    <p>${until}</p>
    <p>If you didn't ask for this, or you want to keep your account, write to <a href="mailto:${escapedSupportEmail}">${escapedSupportEmail}</a> before then.</p>
    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return { templateKey: ACCOUNT_DELETION_REQUESTED_TEMPLATE_KEY, subject, text, html }
}
