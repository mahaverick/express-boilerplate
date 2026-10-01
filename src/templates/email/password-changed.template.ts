/**
 * @file The "your password was changed" notice, sent after a
 * `POST /auth/change-password` succeeded, to tell the real owner. It carries
 * no token and no action link, and its variables hold no secret.
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
export const PASSWORD_CHANGED_TEMPLATE_KEY = 'password_changed' satisfies EmailTemplateKey

/**
 * The variables `renderPasswordChangedTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface PasswordChangedVariables {
  firstName: string
  appName: string
}

/**
 * How email tracking treats this template. No token, so the general sender. Never resent: a second copy would report a password change that did not happen.
 */
export const PASSWORD_CHANGED_TEMPLATE_META: EmailTemplateMeta<PasswordChangedVariables> = {
  senderClass: 'general',
  previewVariables: ['firstName', 'appName'],
  // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PasswordChangedVariables> = [
  'firstName',
  'appName',
]

/**
 * Render the "your password was changed" notice: plain-text and HTML parts,
 * both saying what changed, that it just happened, and what to do if it was
 * not the recipient.
 *
 * It says every other session has been signed out, which `changePassword`
 * (auth.service.ts) does before enqueueing this mail. It does not say the
 * caller's own device is still signed in: a caller whose token has no `sid`
 * has no session to spare, so every session is revoked.
 * @param variables - firstName/appName — see `PasswordChangedVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPasswordChangedTemplate(variables: PasswordChangedVariables): RenderedEmail {
  const { firstName, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    PASSWORD_CHANGED_TEMPLATE_KEY
  )

  const subject = `Your ${appName} password was changed`

  const text = [
    `Hi ${firstName},`,
    '',
    `Your ${appName} password was just changed. Every other session on your account has already been signed out.`,
    '',
    "If this was you, no action is needed. If you don't recognize this change, someone else may have access to your account — visit the forgot-password page to reset it and secure your account immediately.",
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>Your ${escapedAppName} password was just changed. Every other session on your account has already been signed out.</p>
    <p>If this was you, no action is needed. If you don't recognize this change, someone else may have access to your account — visit the forgot-password page to reset it and secure your account immediately.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: PASSWORD_CHANGED_TEMPLATE_KEY, subject, text, html }
}
