/**
 * @file The "passkey deleted" security mail: tells a user a passkey was deleted
 * for their account, and where to go if that was not them. `settingsUrl`
 * arrives fully built, so this stays a pure function of strings.
 */
import type { PasskeySecurityVariables } from '@/templates/email/passkey-created.template'
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
export const PASSKEY_DELETED_TEMPLATE_KEY = 'passkey_deleted' satisfies EmailTemplateKey

/**
 * How email tracking treats this template. It mails from the transactional
 * sender (a security notice), `settingsUrl` is never stored, and no staff
 * resend re-runs it: a resend would repeat a notice about an event that
 * already happened.
 */
export const PASSKEY_DELETED_TEMPLATE_META: EmailTemplateMeta<PasskeySecurityVariables> = {
  senderClass: 'transactional',
  previewVariables: ['firstName', 'providerName', 'occurredAt', 'appName'],
  // oxlint-disable-next-line unicorn/no-null -- no staff resend re-runs a security notice
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PasskeySecurityVariables> = [
  'firstName',
  'providerName',
  'occurredAt',
  'settingsUrl',
  'appName',
]

/**
 * Render the "passkey deleted" message: plain-text and HTML parts, both
 * carrying the Security settings link, unescaped in `text`, escaped in
 * `html`.
 * @param variables - See `PasskeySecurityVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPasskeyDeletedTemplate(variables: PasskeySecurityVariables): RenderedEmail {
  const { firstName, providerName, occurredAt, settingsUrl, appName } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    PASSKEY_DELETED_TEMPLATE_KEY
  )

  const subject = `Passkey deleted from your ${appName} account`

  const text = [
    `Hi ${firstName},`,
    '',
    `You, or someone signed in as you, deleted a passkey (${providerName}) from your ${appName} account at ${occurredAt}.`,
    '',
    `If this wasn't you, sign in and check your passkeys in Security settings: ${settingsUrl}`,
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedFirstName = escapeHtmlForEmail(firstName)
  const escapedProviderName = escapeHtmlForEmail(providerName)
  const escapedOccurredAt = escapeHtmlForEmail(occurredAt)
  const escapedSettingsUrl = escapeHtmlForEmail(settingsUrl)
  const escapedAppName = escapeHtmlForEmail(appName)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapedFirstName},</p>
    <p>You, or someone signed in as you, deleted a passkey (${escapedProviderName}) from your ${escapedAppName} account at ${escapedOccurredAt}.</p>
    <p>If this wasn't you, sign in and check your passkeys in Security settings: <a href="${escapedSettingsUrl}">${escapedSettingsUrl}</a></p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: PASSKEY_DELETED_TEMPLATE_KEY, subject, text, html }
}
