/**
 * @file The interval switch confirmation: when the new interval starts and
 * what it costs. Its one link opens a page in the customer app and carries no
 * token, so it mails from the general sender.
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
export const INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY =
  'interval_switch_scheduled' satisfies EmailTemplateKey

/**
 * The variables `renderIntervalSwitchScheduledTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface IntervalSwitchScheduledVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * How often Paid bills: `month` or `year`.
   */
  interval: 'month' | 'year'
  /**
   * When the new interval starts, as a date in the workspace's time zone.
   */
  switchOn: string
  /**
   * The amount in rupees, formatted, without the sign.
   */
  amount: string
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
export const INTERVAL_SWITCH_SCHEDULED_TEMPLATE_META: EmailTemplateMeta<IntervalSwitchScheduledVariables> =
  {
    senderClass: 'general',
    previewVariables: ['appName', 'tenantName', 'interval', 'switchOn', 'amount', 'billingLink'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof IntervalSwitchScheduledVariables> = [
  'appName',
  'tenantName',
  'interval',
  'switchOn',
  'amount',
  'billingLink',
]

/**
 * Render the interval switch scheduled email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `IntervalSwitchScheduledVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderIntervalSwitchScheduledTemplate(
  variables: IntervalSwitchScheduledVariables
): RenderedEmail {
  const { appName, tenantName, interval, switchOn, amount, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY,
    subject: `Your plan switches to ${interval === 'year' ? 'yearly' : 'monthly'} billing on ${switchOn}`,
    appName,
    paragraphs: [
      `From ${switchOn}, ${tenantName} pays ₹${amount} a ${interval}.`,
      'Your invoices are on the Billing page.',
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
