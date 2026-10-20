/**
 * @file The "sign in" message: one emailed link that signs the recipient in,
 * creating their account on the first click. `signInUrl` arrives fully
 * built, so this stays a pure function of strings.
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
export const SIGN_IN_LINK_TEMPLATE_KEY = 'sign_in_link' satisfies EmailTemplateKey

/**
 * The variables `renderSignInLinkTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime. `reason` is who
 * asked for the link: the recipient (`self`) or a team admin (`staff`).
 */
export interface SignInLinkVariables {
  firstName: string
  signInUrl: string
  expiresInMinutes: string
  expiresAt: string
  appName: string
  reason: 'self' | 'staff'
}

/**
 * How email tracking treats this template. Its link is a full credential,
 * so it mails from the transactional sender and `signInUrl` is never
 * stored. A staff resend sends a fresh staff-sent sign-in link.
 */
export const SIGN_IN_LINK_TEMPLATE_META: EmailTemplateMeta<SignInLinkVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'expiresInMinutes', 'expiresAt', 'appName', 'reason'],
  resendAction: 'sign_in_link',
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof SignInLinkVariables> = [
  'firstName',
  'signInUrl',
  'expiresInMinutes',
  'expiresAt',
  'appName',
  'reason',
]

/**
 * The sentence a staff-sent link adds, so the recipient knows why a link
 * they did not ask for arrived.
 */
const STAFF_SENT_SENTENCE = 'A team admin sent you this link.'

/**
 * Render the "sign in" message: plain-text and HTML parts, both carrying
 * the link, so a text-only client can still act on it: unescaped in `text`,
 * escaped in `html`.
 *
 * `subject` never carries `signInUrl`, which holds the token: mail servers
 * log subjects far more readily than bodies.
 * @param variables - See `SignInLinkVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderSignInLinkTemplate(variables: SignInLinkVariables): RenderedEmail {
  const { firstName, signInUrl, expiresInMinutes, expiresAt, appName, reason } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, SIGN_IN_LINK_TEMPLATE_KEY)

  const subject = `Sign in to ${appName}`
  const isStaffSent = reason === 'staff'

  const text = [
    `Hi ${firstName},`,
    '',
    ...(isStaffSent ? [STAFF_SENT_SENTENCE, ''] : []),
    `Sign in to ${appName}. This link works once and expires in ${expiresInMinutes} minutes, at ${expiresAt}.`,
    '',
    signInUrl,
    '',
    "If you didn't ask to sign in, ignore this email. Nothing changes unless someone opens the link.",
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedSignInUrl = escapeHtmlForEmail(signInUrl)
  const escapedMinutes = escapeHtmlForEmail(expiresInMinutes)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
${isStaffSent ? `    <p>${STAFF_SENT_SENTENCE}</p>\n` : ''}    <p>Sign in to ${escapedAppName}. This link works once and expires in ${escapedMinutes} minutes, at ${escapeHtmlForEmail(expiresAt)}.</p>
    <p><a href="${escapedSignInUrl}">${escapedSignInUrl}</a></p>
    <p>If you didn't ask to sign in, ignore this email. Nothing changes unless someone opens the link.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: SIGN_IN_LINK_TEMPLATE_KEY, subject, text, html }
}
