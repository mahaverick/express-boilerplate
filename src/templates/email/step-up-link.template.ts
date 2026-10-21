/**
 * @file The "confirm it's you" message: one emailed link that confirms a
 * signed-in staff member's identity again, for the Apex session that asked.
 * `confirmUrl` arrives fully built, so this stays a pure function of strings.
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
export const STEP_UP_LINK_TEMPLATE_KEY = 'step_up_link' satisfies EmailTemplateKey

/**
 * The variables `renderStepUpLinkTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface StepUpLinkVariables {
  firstName: string
  confirmUrl: string
  expiresInMinutes: string
  expiresAt: string
  appName: string
}

/**
 * How email tracking treats this template. Its link elevates a session, so
 * it mails from the transactional sender, `confirmUrl` is never stored, and
 * no staff resend re-runs it: a resend would mail a link for a session that
 * is not the resender's.
 */
export const STEP_UP_LINK_TEMPLATE_META: EmailTemplateMeta<StepUpLinkVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName'],
  // oxlint-disable-next-line unicorn/no-null -- no staff resend re-runs this flow
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof StepUpLinkVariables> = [
  'firstName',
  'confirmUrl',
  'expiresInMinutes',
  'expiresAt',
  'appName',
]

/**
 * Render the "confirm it's you" message: plain-text and HTML parts, both
 * carrying the link, so a text-only client can still act on it: unescaped
 * in `text`, escaped in `html`.
 *
 * `subject` never carries `confirmUrl`, which holds the token: mail servers
 * log subjects far more readily than bodies.
 * @param variables - See `StepUpLinkVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderStepUpLinkTemplate(variables: StepUpLinkVariables): RenderedEmail {
  const { firstName, confirmUrl, expiresInMinutes, expiresAt, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    STEP_UP_LINK_TEMPLATE_KEY
  )

  const subject = `Confirm it's you on ${appName}`

  const text = [
    `Hi ${firstName},`,
    '',
    `Confirm it's you to continue in ${appName}. Open this link in the browser you asked from. It works once and expires in ${expiresInMinutes} minutes, at ${expiresAt}.`,
    '',
    confirmUrl,
    '',
    "If you didn't ask for this, someone else is signed in to your account. Don't open the link, and tell your team admin.",
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedConfirmUrl = escapeHtmlForEmail(confirmUrl)
  const escapedMinutes = escapeHtmlForEmail(expiresInMinutes)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>Confirm it's you to continue in ${escapedAppName}. Open this link in the browser you asked from. It works once and expires in ${escapedMinutes} minutes, at ${escapeHtmlForEmail(expiresAt)}.</p>
    <p><a href="${escapedConfirmUrl}">${escapedConfirmUrl}</a></p>
    <p>If you didn't ask for this, someone else is signed in to your account. Don't open the link, and tell your team admin.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: STEP_UP_LINK_TEMPLATE_KEY, subject, text, html }
}
