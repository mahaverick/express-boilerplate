/**
 * @file The "you're on Paid" message, sent when a workspace's first payment
 * authorises a subscription: the amount, the interval and the next charge
 * date. Its one link opens a page in the customer app and carries no token, so
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
export const PAID_WELCOME_TEMPLATE_KEY = 'paid_welcome' satisfies EmailTemplateKey

/**
 * The variables `renderPaidWelcomeTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface PaidWelcomeVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * The amount in rupees, formatted, without the sign.
   */
  amount: string
  /**
   * How often Paid bills: `month` or `year`.
   */
  interval: 'month' | 'year'
  /**
   * When the next charge is, as a date in the workspace's time zone.
   */
  nextChargeOn: string
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
export const PAID_WELCOME_TEMPLATE_META: EmailTemplateMeta<PaidWelcomeVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'amount', 'interval', 'nextChargeOn', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PaidWelcomeVariables> = [
  'appName',
  'tenantName',
  'amount',
  'interval',
  'nextChargeOn',
  'billingLink',
]

/**
 * Render the paid welcome email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `PaidWelcomeVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPaidWelcomeTemplate(variables: PaidWelcomeVariables): RenderedEmail {
  const { appName, tenantName, amount, interval, nextChargeOn, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, PAID_WELCOME_TEMPLATE_KEY)
  return renderBillingEmail({
    templateKey: PAID_WELCOME_TEMPLATE_KEY,
    subject: "You're on Paid",
    appName,
    paragraphs: [
      `${tenantName} is on Paid for ₹${amount} a ${interval}.`,
      `The next charge is on ${nextChargeOn}. Your invoices are on the Billing page.`,
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
