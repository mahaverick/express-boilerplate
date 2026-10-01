/**
 * @file The "your account is ready — set your password" message a
 * staff-created account receives. `setupUrl` arrives fully built, so this
 * stays a pure function of strings.
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
export const ACCOUNT_SETUP_TEMPLATE_KEY = 'account_setup' satisfies EmailTemplateKey

/**
 * The variables `renderAccountSetupTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface AccountSetupVariables {
  firstName: string
  setupUrl: string
  appName: string
}

/**
 * How email tracking treats this template. Its link carries a token, so it mails from the transactional sender; a resend re-runs staff password setup, which sends this or `password_reset`, whichever applies then.
 */
export const ACCOUNT_SETUP_TEMPLATE_META: EmailTemplateMeta<AccountSetupVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'appName'],
  resendAction: 'password_setup',
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountSetupVariables> = [
  'firstName',
  'setupUrl',
  'appName',
]

/**
 * Render the account-setup message: plain-text and HTML parts, both
 * carrying the set-password link, unescaped in `text` and escaped in `html`.
 * The recipient never asked for an account, so the copy says who created it
 * and what to do if it is unexpected.
 *
 * `subject` never carries `setupUrl`, which holds a single-use token: mail
 * servers log subjects far more readily than bodies.
 * @param variables - firstName/setupUrl/appName — see `AccountSetupVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderAccountSetupTemplate(variables: AccountSetupVariables): RenderedEmail {
  const { firstName, setupUrl, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_SETUP_TEMPLATE_KEY
  )

  const subject = `Your ${appName} account is ready — set your password`

  const text = [
    `Hi ${firstName},`,
    '',
    `The ${appName} team has created an account for you. Visit the link below to choose your password and sign in:`,
    '',
    setupUrl,
    '',
    'The link works once. If it has expired, ask the team for a new one.',
    'If you were not expecting this account, you can ignore this email.',
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedSetupUrl = escapeHtmlForEmail(setupUrl)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>The ${escapedAppName} team has created an account for you. Click the link below to choose your password and sign in:</p>
    <p><a href="${escapedSetupUrl}">${escapedSetupUrl}</a></p>
    <p>The link works once. If it has expired, ask the team for a new one.</p>
    <p>If you were not expecting this account, you can ignore this email.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: ACCOUNT_SETUP_TEMPLATE_KEY, subject, text, html }
}
