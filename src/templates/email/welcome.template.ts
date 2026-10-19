/**
 * @file The "welcome" message: the mail a user gets when staff create their
 * account, carrying one sign-in link. The first click signs them in and
 * verifies the address. `signInUrl` arrives fully built, so this stays a
 * pure function of strings.
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
export const WELCOME_TEMPLATE_KEY = 'welcome' satisfies EmailTemplateKey

/**
 * The variables `renderWelcomeTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface WelcomeVariables {
  firstName: string
  signInUrl: string
  expiresInMinutes: string
  appName: string
}

/**
 * How email tracking treats this template. Its link is a full credential,
 * so it mails from the transactional sender and `signInUrl` is never
 * stored. A staff resend sends a fresh sign-in link.
 */
export const WELCOME_TEMPLATE_META: EmailTemplateMeta<WelcomeVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'expiresInMinutes', 'appName'],
  resendAction: 'sign_in_link',
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof WelcomeVariables> = [
  'firstName',
  'signInUrl',
  'expiresInMinutes',
  'appName',
]

/**
 * Render the "welcome" message: plain-text and HTML parts, both carrying
 * the link, so a text-only client can still act on it: unescaped in `text`,
 * escaped in `html`.
 *
 * `subject` never carries `signInUrl`, which holds the token: mail servers
 * log subjects far more readily than bodies.
 * @param variables - See `WelcomeVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderWelcomeTemplate(variables: WelcomeVariables): RenderedEmail {
  const { firstName, signInUrl, expiresInMinutes, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    WELCOME_TEMPLATE_KEY
  )

  const subject = `Your ${appName} account is ready`

  const text = [
    `Hi ${firstName},`,
    '',
    `Your ${appName} account is ready. Sign in with this link. It works once and expires in ${expiresInMinutes} minutes.`,
    '',
    signInUrl,
    '',
    `If the link expires, enter your email address on the ${appName} sign-in page to get a new one.`,
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
    <p>Your ${escapedAppName} account is ready. Sign in with this link. It works once and expires in ${escapedMinutes} minutes.</p>
    <p><a href="${escapedSignInUrl}">${escapedSignInUrl}</a></p>
    <p>If the link expires, enter your email address on the ${escapedAppName} sign-in page to get a new one.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: WELCOME_TEMPLATE_KEY, subject, text, html }
}
