/**
 * @file The "someone tried to register with your email address" notice, sent
 * to an existing account's owner so registration can answer the same way for
 * a free and a taken address. It carries no token and no URL.
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
export const REGISTRATION_ATTEMPT_TEMPLATE_KEY = 'registration_attempt' satisfies EmailTemplateKey

/**
 * The variables `renderRegistrationAttemptTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface RegistrationAttemptVariables {
  firstName: string
  appName: string
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof RegistrationAttemptVariables> = [
  'firstName',
  'appName',
]

/**
 * Render the "someone tried to register with your email" notice: plain-text
 * and HTML parts carrying the same information, with no action link.
 * @param variables - firstName/appName — see `RegistrationAttemptVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderRegistrationAttemptTemplate(
  variables: RegistrationAttemptVariables
): RenderedEmail {
  const { firstName, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    REGISTRATION_ATTEMPT_TEMPLATE_KEY
  )

  const subject = `A registration attempt used your ${appName} email address`

  const text = [
    `Hi ${firstName},`,
    '',
    `Someone just tried to create a new ${appName} account using this email address — but you already have one.`,
    '',
    'If this was you, no action is needed: you can log in with your existing account instead.',
    '',
    "If you don't recognize this, no changes were made to your account and you can safely ignore this email. If you're concerned, you can reset your password from the login page at any time.",
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>Someone just tried to create a new ${escapedAppName} account using this email address — but you already have one.</p>
    <p>If this was you, no action is needed: you can log in with your existing account instead.</p>
    <p>If you don't recognize this, no changes were made to your account and you can safely ignore this email. If you're concerned, you can reset your password from the login page at any time.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: REGISTRATION_ATTEMPT_TEMPLATE_KEY, subject, text, html }
}
