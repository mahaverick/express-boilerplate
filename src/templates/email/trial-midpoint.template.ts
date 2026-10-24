/**
 * @file The mid-trial message: the days left and up to three facts about what
 * the workspace has used so far. Its one link opens a page in the customer app
 * and carries no token, so it mails from the general sender.
 */
import { countOf, renderBillingEmail } from '@/templates/email/billing-layout.template'
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
export const TRIAL_MIDPOINT_TEMPLATE_KEY = 'trial_midpoint' satisfies EmailTemplateKey

/**
 * The variables `renderTrialMidpointTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface TrialMidpointVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * Whole days left in the trial, as digits.
   */
  daysLeft: string
  /**
   * When the trial ends, as a date in the workspace's time zone.
   */
  trialEndsOn: string
  /**
   * Up to three facts about what the workspace uses, one per line.
   */
  usageSummary: string
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
export const TRIAL_MIDPOINT_TEMPLATE_META: EmailTemplateMeta<TrialMidpointVariables> = {
  senderClass: 'general',
  previewVariables: [
    'appName',
    'tenantName',
    'daysLeft',
    'trialEndsOn',
    'usageSummary',
    'billingLink',
  ],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TrialMidpointVariables> = [
  'appName',
  'tenantName',
  'daysLeft',
  'trialEndsOn',
  'usageSummary',
  'billingLink',
]

/**
 * Render the trial midpoint email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `TrialMidpointVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderTrialMidpointTemplate(variables: TrialMidpointVariables): RenderedEmail {
  const { appName, tenantName, daysLeft, trialEndsOn, usageSummary, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, TRIAL_MIDPOINT_TEMPLATE_KEY)
  return renderBillingEmail({
    templateKey: TRIAL_MIDPOINT_TEMPLATE_KEY,
    subject: `${countOf(daysLeft, 'day')} left in your Paid trial`,
    appName,
    paragraphs: [
      `${tenantName} is on a Paid trial until ${trialEndsOn}. So far it has:`,
      ...usageSummary.split('\n').filter((line) => line !== ''),
      'To keep Paid after the trial, upgrade from Billing.',
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
