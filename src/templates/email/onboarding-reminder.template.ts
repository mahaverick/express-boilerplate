/**
 * @file The "pick up where you left off" reminder a staff member sends to a
 * tenant's active owners while its onboarding is in progress or stuck. It
 * carries no token: its one link opens the tenant's overview in the
 * customer app, so it mails from the general sender and its link is stored
 * and shown in the staff preview. The tenant name is user-chosen text, so
 * it stays out of the subject.
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
export const ONBOARDING_REMINDER_TEMPLATE_KEY = 'onboarding_reminder' satisfies EmailTemplateKey

/**
 * The variables `renderOnboardingReminderTemplate` needs. All are required
 * strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface OnboardingReminderVariables {
  /**
   * The tenant's display name.
   */
  tenantName: string
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The title of the tenant's next required onboarding step.
   */
  nextStep: string
  /**
   * The tenant's overview page in the customer app. Named `…Link`, not
   * `…Url`: it carries no token, so it is stored and previewed.
   */
  overviewLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender, and every variable is stored for the preview. Never resent: staff send a new reminder, which the 24-hour limit governs.
 */
export const ONBOARDING_REMINDER_TEMPLATE_META: EmailTemplateMeta<OnboardingReminderVariables> = {
  senderClass: 'general',
  previewVariables: ['tenantName', 'appName', 'nextStep', 'overviewLink'],
  // eslint-disable-next-line unicorn/no-null -- the registry's "never resent" value
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof OnboardingReminderVariables> = [
  'tenantName',
  'appName',
  'nextStep',
  'overviewLink',
]

/**
 * Render the onboarding reminder: plain-text and HTML parts, both naming
 * the next step and carrying the overview link.
 * @param variables - See `OnboardingReminderVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderOnboardingReminderTemplate(
  variables: OnboardingReminderVariables
): RenderedEmail {
  const { tenantName, appName, nextStep, overviewLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ONBOARDING_REMINDER_TEMPLATE_KEY
  )

  const subject = `Finish getting started on ${appName}`

  const text = [
    'Hi,',
    '',
    `${tenantName} is part of the way through getting started on ${appName}.`,
    '',
    `Next step: ${nextStep}`,
    '',
    'Pick up where you left off:',
    '',
    overviewLink,
    '',
    `— The ${appName} team`,
  ].join('\n')

  const escapedTenantName = escapeHtmlForEmail(tenantName)
  const escapedAppName = escapeHtmlForEmail(appName)
  const escapedNextStep = escapeHtmlForEmail(nextStep)
  const escapedOverviewLink = escapeHtmlForEmail(overviewLink)

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi,</p>
    <p>${escapedTenantName} is part of the way through getting started on ${escapedAppName}.</p>
    <p>Next step: ${escapedNextStep}</p>
    <p><a href="${escapedOverviewLink}">Pick up where you left off</a></p>
    <p>Or paste this link into your browser: ${escapedOverviewLink}</p>
    <p>— The ${escapedAppName} team</p>
  </body>
</html>`

  return { templateKey: ONBOARDING_REMINDER_TEMPLATE_KEY, subject, text, html }
}
