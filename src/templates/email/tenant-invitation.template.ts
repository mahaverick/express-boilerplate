/**
 * @file The "you've been invited to join a team" message. The accept link
 * carries the raw invitation token, so it never appears in the subject; tenant
 * and inviter names are user-chosen text, so they stay out of it too.
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
export const TENANT_INVITATION_TEMPLATE_KEY = 'tenant_invitation' satisfies EmailTemplateKey

/**
 * The variables `renderTenantInvitationTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface TenantInvitationVariables {
  /**
   * The tenant's display name.
   */
  tenantName: string
  /**
   * Who sent the invitation, or "A teammate".
   */
  inviterName: string
  /**
   * The role the invitee gets on accepting.
   */
  role: string
  /**
   * The frontend accept page, carrying the raw token.
   */
  acceptUrl: string
  /**
   * Whole days until the link expires.
   */
  expiresInDays: string
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
}

/**
 * How email tracking treats this template. Its link carries a token, so it mails from the transactional sender; a resend re-sends the same invitation with a new link. `inviterName` is not stored: it is another person's name, which that person's purge could not find here.
 */
export const TENANT_INVITATION_TEMPLATE_META: EmailTemplateMeta<TenantInvitationVariables> = {
  senderClass: 'transactional',
  previewVariables: ['tenantName', 'role', 'expiresInDays', 'appName'],
  resendAction: 'invitation',
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TenantInvitationVariables> = [
  'tenantName',
  'inviterName',
  'role',
  'acceptUrl',
  'expiresInDays',
  'appName',
]

/**
 * Render the invitation email: plain-text and HTML parts, both carrying the
 * accept link and the instructions for a reader without an account.
 * @param variables - See `TenantInvitationVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderTenantInvitationTemplate(
  variables: TenantInvitationVariables
): RenderedEmail {
  const { tenantName, inviterName, role, acceptUrl, expiresInDays, appName } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, TENANT_INVITATION_TEMPLATE_KEY)

  const lifetime = expiresInDays === '1' ? '1 day' : `${expiresInDays} days`
  const subject = `You've been invited to join a team on ${appName}`

  const text = [
    'Hi,',
    '',
    `${inviterName} invited you to join ${tenantName} on ${appName} as ${role}.`,
    '',
    'Accept the invitation here:',
    '',
    acceptUrl,
    '',
    `This link expires in ${lifetime}.`,
    '',
    `No ${appName} account yet? Create one with this email address, verify it, then open this link again.`,
    '',
    "If you weren't expecting this invitation, you can ignore this email.",
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedTenantName = escapeHtmlForEmail(tenantName)
  const escapedInviterName = escapeHtmlForEmail(inviterName)
  const escapedRole = escapeHtmlForEmail(role)
  const escapedAcceptUrl = escapeHtmlForEmail(acceptUrl)
  const escapedLifetime = escapeHtmlForEmail(lifetime)
  const escapedAppName = escapeHtmlForEmail(appName)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi,</p>
    <p>${escapedInviterName} invited you to join ${escapedTenantName} on ${escapedAppName} as ${escapedRole}.</p>
    <p><a href="${escapedAcceptUrl}">Accept the invitation</a></p>
    <p>Or paste this link into your browser: ${escapedAcceptUrl}</p>
    <p>This link expires in ${escapedLifetime}.</p>
    <p>No ${escapedAppName} account yet? Create one with this email address, verify it, then open this link again.</p>
    <p>If you weren't expecting this invitation, you can ignore this email.</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: TENANT_INVITATION_TEMPLATE_KEY, subject, text, html }
}
