/**
 * @file The "maintenance mode changed" notice to every other platform owner
 * and admin when maintenance is switched on, escalated or switched off. It
 * carries no token and no link; its variables hold no secret.
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
export const MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY =
  'maintenance_mode_changed' satisfies EmailTemplateKey

/**
 * The variables `renderMaintenanceModeChangedTemplate` needs. All are
 * required strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface MaintenanceModeChangedVariables {
  firstName: string
  appName: string
  /**
   * The new mode as words: `off`, `read-only` or `full`.
   */
  mode: string
  /**
   * The staff member who changed it.
   */
  actorName: string
  /**
   * Their stated reason, or a fixed "No reason given." when they gave none.
   */
  reason: string
  /**
   * When it changed, ISO 8601 UTC.
   */
  changedAt: string
}

/**
 * How email tracking treats this template. No token, so the general sender.
 * The actor's name and the reason are not stored: one is another person's
 * name a purge could not find, the other internal text that stays in the
 * audit log. Never resent: a second copy would report a change that did not
 * happen again.
 */
export const MAINTENANCE_MODE_CHANGED_TEMPLATE_META: EmailTemplateMeta<MaintenanceModeChangedVariables> =
  {
    senderClass: 'general',
    previewVariables: ['firstName', 'appName', 'mode', 'changedAt'],
    // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof MaintenanceModeChangedVariables> = [
  'firstName',
  'appName',
  'mode',
  'actorName',
  'reason',
  'changedAt',
]

/**
 * Render the "maintenance mode changed" notice: plain-text and HTML parts
 * naming the new mode, who set it, why and when.
 * @param variables - See `MaintenanceModeChangedVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderMaintenanceModeChangedTemplate(
  variables: MaintenanceModeChangedVariables
): RenderedEmail {
  const { firstName, appName, mode, actorName, reason, changedAt } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY
  )

  const subject = `${appName} maintenance mode is now ${mode}`
  const summary = `${actorName} set ${appName} maintenance mode to ${mode} at ${changedAt}.`

  const text = [
    `Hi ${firstName},`,
    '',
    summary,
    `Reason: ${reason}`,
    '',
    'You are receiving this because you are a platform owner or admin. Manage maintenance mode from Apex.',
    '',
    `— The ${appName} team`,
  ].join('\n')

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapeHtmlForEmail(firstName)},</p>
    <p>${escapeHtmlForEmail(summary)}</p>
    <p>Reason: ${escapeHtmlForEmail(reason)}</p>
    <p>You are receiving this because you are a platform owner or admin. Manage maintenance mode from Apex.</p>
    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return { templateKey: MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY, subject, text, html }
}
