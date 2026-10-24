/**
 * @file The "your Paid trial has started" message, sent to the owners when a
 * workspace starts its trial: when it ends, and that nothing is deleted after
 * it. Its one link opens a page in the customer app and carries no token, so
 * it mails from the general sender.
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
export const TRIAL_STARTED_TEMPLATE_KEY = 'trial_started' satisfies EmailTemplateKey

/**
 * The variables `renderTrialStartedTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface TrialStartedVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * When the trial ends, as a date in the workspace's time zone.
   */
  trialEndsOn: string
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
export const TRIAL_STARTED_TEMPLATE_META: EmailTemplateMeta<TrialStartedVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'trialEndsOn', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TrialStartedVariables> = [
  'appName',
  'tenantName',
  'trialEndsOn',
  'billingLink',
]

/**
 * Render the trial started email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `TrialStartedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderTrialStartedTemplate(variables: TrialStartedVariables): RenderedEmail {
  const { appName, tenantName, trialEndsOn, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    TRIAL_STARTED_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: TRIAL_STARTED_TEMPLATE_KEY,
    subject: `Your ${appName} Paid trial runs until ${trialEndsOn}`,
    appName,
    paragraphs: [
      `Everything in Paid is on until ${trialEndsOn}. Then ${tenantName} moves to Free. Nothing is deleted, and no card is needed.`,
      'To stay on Paid after the trial, upgrade from Billing.',
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
