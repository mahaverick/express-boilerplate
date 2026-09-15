// src/templates/email/email-verification.template.ts
//
// The "verify your email address" message sent after registration.
// `verificationUrl` is the full, ready-to-click link, handed in by the
// caller — this template does not build it from a raw token or a base URL.
// That assembly belongs to a later task's controller (Task 5), for two
// reasons: this file stays a pure function of already-assembled strings
// (trivial to unit-test with no env/config dependency at all), and the one
// module that DOES know how to turn a token into a link is also the one
// that must never put that link anywhere but here and the text/html
// bodies — never the subject. See this file's own subject line below.
import {
  escapeHtmlForEmail,
  requireEmailVariables,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@/utilities/email-template.utilities'

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS` (email-template.utilities.ts),
 * checked against that union rather than left a bare string literal — a
 * typo here is a compile error, not a silently-mismatched key.
 *
 * `satisfies`, not a `: EmailTemplateKey` annotation — an annotation would
 * WIDEN this constant's type to the whole union, which is exactly wrong for
 * `mailer.service.ts`'s `MailMessage` discriminated union: that union
 * narrows on the LITERAL `'email_verification'`, not on "any
 * EmailTemplateKey", so a caller passing this key must get
 * `EmailVerificationVariables` specifically, not a choice of all three
 * templates' variable shapes. `satisfies` keeps the literal type while
 * still checking membership in the union — the same compile-error-on-typo
 * guarantee, without the widening.
 */
export const EMAIL_VERIFICATION_TEMPLATE_KEY = 'email_verification' satisfies EmailTemplateKey

/**
 * The variables `renderEmailVerificationTemplate` needs, all required: a
 * missing one throws rather than rendering `undefined` — see
 * `requireEmailVariables`'s own comment for why that check exists at
 * runtime despite every field already being declared required here.
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
 * carrying the verification link, so a text-only client can still act on it
 * — task-3-brief.md's own requirement, and the reason `verificationUrl`
 * appears in `text` unescaped (plain text has no markup to break) and in
 * `html` only after `escapeHtmlForEmail`.
 *
 * `subject` never interpolates `verificationUrl` — no token may appear in a
 * subject line, because mail servers log subjects far more readily than
 * bodies (task-3-brief.md's Controller addendum). `appName` is safe there:
 * it is an operator-configured constant, never user-supplied, and carries
 * no secret.
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

  // Escaped once, into named consts, rather than inline inside the html
  // template literal below — avoids nesting one template literal's
  // expression inside another, which trips sonarjs/no-nested-template-literals
  // for no readability gain (the same reason email-log.model.ts pulls its
  // own SQL fragments out to a top-level const first).
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
