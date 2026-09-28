/**
 * @file The "verify your email address" message sent after registration.
 * `verificationUrl` arrives fully built, so this stays a pure function of
 * strings.
 */
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS`. `satisfies`, not an
 * annotation, so it stays the literal `MailMessage`'s union narrows on.
 */
export const EMAIL_VERIFICATION_TEMPLATE_KEY = 'email_verification' satisfies EmailTemplateKey

/**
 * The variables `renderEmailVerificationTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface EmailVerificationVariables {
  firstName: string
  verificationUrl: string
  appName: string
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof EmailVerificationVariables> = [
  'firstName',
  'verificationUrl',
  'appName',
]

/**
 * Render the "verify your email" message: plain-text and HTML parts, both
 * carrying the verification link, so a text-only client can still act on
 * it: unescaped in `text`, escaped in `html`.
 *
 * `subject` never carries the link: mail servers log subjects far more
 * readily than bodies, so no token appears there. `appName` is safe there,
 * an operator-configured constant with no secret.
 * @param variables - firstName/verificationUrl/appName — see `EmailVerificationVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderEmailVerificationTemplate(
  variables: EmailVerificationVariables
): RenderedEmail {
  const { firstName, verificationUrl, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    EMAIL_VERIFICATION_TEMPLATE_KEY
  )

  const subject = `Verify your email for ${appName}`

  const text = [
    `Hi ${firstName},`,
    '',
    `Thanks for signing up for ${appName}. Verify your email address by visiting the link below:`,
    '',
    verificationUrl,
    '',
    'If you did not create this account, you can safely ignore this email.',
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedVerificationUrl = escapeHtmlForEmail(verificationUrl)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>Thanks for signing up for ${escapedAppName}. Verify your email address by clicking the link below:</p>
    <p><a href="${escapedVerificationUrl}">${escapedVerificationUrl}</a></p>
    <p>If you did not create this account, you can safely ignore this email.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: EMAIL_VERIFICATION_TEMPLATE_KEY, subject, text, html }
}
