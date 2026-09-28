/**
 * @file The "reset your password" message. `resetUrl` arrives fully built, so
 * this stays a pure function of strings.
 */
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS`. `satisfies`, not an
 * annotation, so it keeps the literal type that `MailMessage`'s union
 * narrows on.
 */
export const PASSWORD_RESET_TEMPLATE_KEY = 'password_reset' satisfies EmailTemplateKey

/**
 * The variables `renderPasswordResetTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface PasswordResetVariables {
  firstName: string
  resetUrl: string
  appName: string
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PasswordResetVariables> = [
  'firstName',
  'resetUrl',
  'appName',
]

/**
 * Render the "reset your password" message: plain-text and HTML parts, both
 * carrying the reset link, so a text-only client can still act on it:
 * unescaped in `text`, escaped in `html`.
 *
 * `subject` never carries `resetUrl`, which holds the reset token: mail
 * servers log subjects far more readily than bodies. `appName` is safe
 * there, an operator-configured constant with no secret.
 * @param variables - firstName/resetUrl/appName — see `PasswordResetVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPasswordResetTemplate(variables: PasswordResetVariables): RenderedEmail {
  const { firstName, resetUrl, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    PASSWORD_RESET_TEMPLATE_KEY
  )

  const subject = `Reset your ${appName} password`

  const text = [
    `Hi ${firstName},`,
    '',
    `We received a request to reset your ${appName} password. Visit the link below to choose a new one:`,
    '',
    resetUrl,
    '',
    'If you did not request a password reset, you can safely ignore this email — your password will not change.',
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedResetUrl = escapeHtmlForEmail(resetUrl)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>We received a request to reset your ${escapedAppName} password. Click the link below to choose a new one:</p>
    <p><a href="${escapedResetUrl}">${escapedResetUrl}</a></p>
    <p>If you did not request a password reset, you can safely ignore this email — your password will not change.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: PASSWORD_RESET_TEMPLATE_KEY, subject, text, html }
}
