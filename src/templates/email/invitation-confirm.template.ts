/**
 * @file The "finish joining" message: one emailed link, mailed when an
 * invitation is opened for an address that has an account, or for any staff
 * invitation. Its click signs the recipient in and joins them. `confirmUrl`
 * arrives fully built, so this stays a pure function of strings.
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
export const INVITATION_CONFIRM_TEMPLATE_KEY = 'invitation_confirm' satisfies EmailTemplateKey

/**
 * The variables `renderInvitationConfirmTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface InvitationConfirmVariables {
  firstName: string
  tenantName: string
  role: string
  confirmUrl: string
  expiresInMinutes: string
  expiresAt: string
  appName: string
}

/**
 * How email tracking treats this template. Its link is a full credential,
 * so it mails from the transactional sender and `confirmUrl` is never
 * stored. A staff resend sends the invitation itself again.
 */
export const INVITATION_CONFIRM_TEMPLATE_META: EmailTemplateMeta<InvitationConfirmVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'tenantName', 'role', 'expiresInMinutes', 'expiresAt', 'appName'],
  resendAction: 'invitation',
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof InvitationConfirmVariables> = [
  'firstName',
  'tenantName',
  'role',
  'confirmUrl',
  'expiresInMinutes',
  'expiresAt',
  'appName',
]

/**
 * Render the "finish joining" message: plain-text and HTML parts, both
 * carrying the link, unescaped in `text` and escaped in `html`.
 *
 * `subject` carries neither the tenant name (text a workspace owner chose)
 * nor `confirmUrl`, which holds the token: mail servers log subjects far
 * more readily than bodies.
 * @param variables - See `InvitationConfirmVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderInvitationConfirmTemplate(
  variables: InvitationConfirmVariables
): RenderedEmail {
  const { firstName, tenantName, role, confirmUrl, expiresInMinutes, expiresAt, appName } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, INVITATION_CONFIRM_TEMPLATE_KEY)

  const subject = `Finish joining your team on ${appName}`

  const text = [
    `Hi ${firstName},`,
    '',
    `Sign in and join ${tenantName} as ${role} with this link. It works once and expires in ${expiresInMinutes} minutes, at ${expiresAt}.`,
    '',
    confirmUrl,
    '',
    `We sent it because someone opened your invitation to ${tenantName}. If that wasn't you, ignore this email. Nothing changes unless someone opens this link.`,
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedTenantName = escapeHtmlForEmail(tenantName)
  const escapedRole = escapeHtmlForEmail(role)
  const escapedConfirmUrl = escapeHtmlForEmail(confirmUrl)
  const escapedMinutes = escapeHtmlForEmail(expiresInMinutes)
  const escapedAppName = escapeHtmlForEmail(appName)
  const reason = escapeHtmlForEmail(
    `We sent it because someone opened your invitation to ${tenantName}. If that wasn't you, ignore this email. Nothing changes unless someone opens this link.`
  )

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>Sign in and join ${escapedTenantName} as ${escapedRole} with this link. It works once and expires in ${escapedMinutes} minutes, at ${escapeHtmlForEmail(expiresAt)}.</p>
    <p><a href="${escapedConfirmUrl}" style="display: inline-block; padding: 10px 16px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px;">Join ${escapedTenantName}</a></p>
    <p>Or paste this link into your browser: ${escapedConfirmUrl}</p>
    <p>${reason}</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: INVITATION_CONFIRM_TEMPLATE_KEY, subject, text, html }
}
