// src/templates/email/password-changed.template.ts
//
// "Your password was changed" — sent after a `POST /auth/change-password`
// request already succeeded, never before: the point is to tell the real
// owner it happened, not to ask permission. Unlike password-reset.template.ts
// and email-verification.template.ts, this template carries no token and no
// action link at all — the same shape registration-attempt.template.ts
// already uses, and for a related reason: there is nothing here for a
// recipient to click that would DO anything (the change is already done),
// only somewhere to go if it was not them.
//
// ONE THING WORTH FLAGGING for a reader comparing this file to its
// neighbours: notification.worker.ts strips `variables` out of a
// notification job's persisted `metadata` before the database insert,
// specifically because `email.variables` is where a raw verification/reset
// token lives for those other templates. This template's variables —
// `firstName`, `appName` — carry no secret at all, so that stripping rule is
// satisfied here TRIVIALLY, not load-bearingly. That is not a sign the rule
// was forgotten for this template; there was simply never anything here for
// it to protect.
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
export const PASSWORD_CHANGED_TEMPLATE_KEY = 'password_changed' satisfies EmailTemplateKey

/**
 * The variables `renderPasswordChangedTemplate` needs, all required: a
 * missing one throws rather than rendering `undefined` — see
 * `requireEmailVariables`'s own comment for why that check exists at
 * runtime despite every field already being declared required here.
 */
export interface PasswordChangedVariables {
  firstName: string
  appName: string
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PasswordChangedVariables> = [
  'firstName',
  'appName',
]

/**
 * Render the "your password was changed" notice: plain-text and HTML parts,
 * both carrying the same three things — what changed, that it just
 * happened, and what to do if it was not the recipient. Deliberately tells
 * the reader every OTHER session has already been signed out: that is true
 * (`changePassword`, auth.controller.ts, revokes them before this mail is
 * even enqueued) and is the reassuring half of the message — a caller who
 * did not make this change needs to know their other sessions are already
 * dead, not merely that something happened.
 *
 * It says "every OTHER session", and deliberately does NOT add "only the
 * device you used is still signed in" — which read better and was false.
 * When the caller's access token predates the `sid` claim there is no
 * session to spare, so `changePassword` revokes EVERY session including
 * theirs; that reader would have been told their device was still signed
 * in moments before it stopped working. "Every other session" stays true
 * in both branches — it is simply not exhaustive in that one.
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
