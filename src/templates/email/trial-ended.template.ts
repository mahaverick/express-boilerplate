/**
 * @file The "your trial ended" message: the workspace is on Free, with the
 * trial's summary of what Free takes away. Its one link opens a page in the
 * customer app and carries no token, so it mails from the general sender.
 */
import { renderBillingEmail } from '@/templates/email/billing-layout.template'
import {
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
export const TRIAL_ENDED_TEMPLATE_KEY = 'trial_ended' satisfies EmailTemplateKey

/**
 * The variables `renderTrialEndedTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface TrialEndedVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * What Free takes away from this workspace, one fact per line.
   */
  summary: string
  /**
   * The workspace's Billing page. Named `…Link`, not `…Url`: it carries no
   * token, so it is stored and previewed.
   */
  billingLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored for the preview. Never resent.
 */
export const TRIAL_ENDED_TEMPLATE_META: EmailTemplateMeta<TrialEndedVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'summary', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TrialEndedVariables> = [
  'appName',
  'tenantName',
  'summary',
  'billingLink',
]

/**
 * Render the trial ended email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `TrialEndedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderTrialEndedTemplate(variables: TrialEndedVariables): RenderedEmail {
  const { appName, tenantName, summary, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    TRIAL_ENDED_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: TRIAL_ENDED_TEMPLATE_KEY,
    subject: `Your ${appName} workspace is now on Free`,
    appName,
    paragraphs: [
      `The Paid trial of ${tenantName} ended, so it is on Free. Nothing is deleted.`,
      ...summary.split('\n').filter((line) => line !== ''),
      'To get Paid back, upgrade from Billing.',
    ],
    button: { label: 'Upgrade to Paid', link: billingLink },
  })
}
