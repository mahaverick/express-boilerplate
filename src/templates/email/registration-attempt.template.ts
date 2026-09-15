// src/templates/email/registration-attempt.template.ts
//
// "Someone tried to register with your email address" — sent to an EXISTING
// account's owner when a registration attempt targets their address, so the
// registration endpoint can return its normal success response either way
// (Task 5 closes the account-enumeration channel this way; this template is
// the notification half of that fix). Unlike the other two templates, this
// one carries no token and no URL at all: it is purely informational, which
// also means "no token may appear in a subject line" is true here by
// construction rather than by a rule this file has to remember to follow.
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
export const REGISTRATION_ATTEMPT_TEMPLATE_KEY = 'registration_attempt' satisfies EmailTemplateKey

/**
 * The variables `renderRegistrationAttemptTemplate` needs, all required: a
 * missing one throws rather than rendering `undefined` — see
 * `requireEmailVariables`'s own comment for why that check exists at
 * runtime despite every field already being declared required here.
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
 * and HTML parts. No action link is included — there is no token to carry
 * one, deliberately (see this file's own header comment) — so, unlike the
 * other two templates, the plain-text/HTML parity requirement here is just
 * "the same information in both forms," not "the same actionable URL in
 * both forms."
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

  // Escaped once, into named consts, rather than inline inside the html
  // template literal below — see email-verification.template.ts's own
  // comment on this pattern (dodges sonarjs/no-nested-template-literals).
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
