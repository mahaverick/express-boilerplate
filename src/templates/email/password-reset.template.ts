// src/templates/email/password-reset.template.ts
//
// The "reset your password" message. `resetUrl` is the full, ready-to-click
// link, handed in by the caller — see email-verification.template.ts's own
// header comment for why this template does not build it itself.
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS` (email-template.utilities.ts).
 * `satisfies`, not a `: EmailTemplateKey` annotation — see
 * email-verification.template.ts's own comment on
 * `EMAIL_VERIFICATION_TEMPLATE_KEY` for why: an annotation would widen this
 * to the whole union, which breaks the literal narrowing
 * `mailer.service.ts`'s `MailMessage` discriminated union depends on.
 */
export const PASSWORD_RESET_TEMPLATE_KEY = 'password_reset' satisfies EmailTemplateKey

/**
 * The variables `renderPasswordResetTemplate` needs, all required: a
 * missing one throws rather than rendering `undefined` — see
 * `requireEmailVariables`'s own comment for why that check exists at
 * runtime despite every field already being declared required here.
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
 * carrying the reset link, so a text-only client can still act on it —
 * task-3-brief.md's own requirement, and the reason `resetUrl` appears in
 * `text` unescaped (plain text has no markup to break) and in `html` only
 * after `escapeHtmlForEmail`.
 *
 * `subject` never interpolates `resetUrl` — the one variable in this
 * template a compromised or replayed link would actually carry the reset
 * token in. No token may appear in a subject line: mail servers log
 * subjects far more readily than bodies (task-3-brief.md's Controller
 * addendum). `appName` is safe there: an operator-configured constant,
 * never user-supplied, carrying no secret.
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

  // Escaped once, into named consts, rather than inline inside the html
  // template literal below — see email-verification.template.ts's own
  // comment on this pattern (dodges sonarjs/no-nested-template-literals).
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
