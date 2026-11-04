/**
 * @file The account deleted confirmation: tells a customer who asked us to
 * delete their account that we did, that the address can start a new
 * account, and where to write if they did not ask. Sent only when a staff
 * delete completed an open deletion request. It carries no token and no
 * link; its variables hold no secret.
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
export const ACCOUNT_DELETED_TEMPLATE_KEY = 'account_deleted' satisfies EmailTemplateKey

/**
 * The variables `renderAccountDeletedTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface AccountDeletedVariables {
  firstName: string
  appName: string
  /**
   * The support address (`supportAddress`, email-sender.utilities.ts).
   */
  supportEmail: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored. Never resent: the account is gone, and a
 * second copy would read as a second deletion.
 */
export const ACCOUNT_DELETED_TEMPLATE_META: EmailTemplateMeta<AccountDeletedVariables> = {
  senderClass: 'general',
  previewVariables: ['firstName', 'appName', 'supportEmail'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountDeletedVariables> = [
  'firstName',
  'appName',
  'supportEmail',
]

/**
 * Render the account deleted confirmation: plain-text and HTML parts naming
 * the support address.
 * @param variables - See `AccountDeletedVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderAccountDeletedTemplate(variables: AccountDeletedVariables): RenderedEmail {
  const { firstName, appName, supportEmail } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_DELETED_TEMPLATE_KEY
  )

  const subject = 'We deleted your account'
  const deleted = `We deleted your ${appName} account, as you asked.`
  const after =
    'You can no longer sign in to it. If you sign in with this address again, you get a new, empty account.'

  const text = [
    `Hi ${firstName},`,
    '',
    deleted,
    '',
    after,
    '',
    `If you didn't ask for this, write to ${supportEmail}.`,
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedSupportEmail = escapeHtmlForEmail(supportEmail)
  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapeHtmlForEmail(firstName)},</p>
    <p>${escapeHtmlForEmail(deleted)}</p>
    <p>${after}</p>
    <p>If you didn't ask for this, write to <a href="mailto:${escapedSupportEmail}">${escapedSupportEmail}</a>.</p>
    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return { templateKey: ACCOUNT_DELETED_TEMPLATE_KEY, subject, text, html }
}
