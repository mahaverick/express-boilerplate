/**
 * @file The yearly renewal reminder: the renewal date and amount, and how to
 * stop it. Its one link opens a page in the customer app and carries no token,
 * so it mails from the general sender.
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
export const RENEWAL_UPCOMING_TEMPLATE_KEY = 'renewal_upcoming' satisfies EmailTemplateKey

/**
 * The variables `renderRenewalUpcomingTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface RenewalUpcomingVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * When the plan renews, as a date in the workspace's time zone.
   */
  renewsOn: string
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
export const RENEWAL_UPCOMING_TEMPLATE_META: EmailTemplateMeta<RenewalUpcomingVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'renewsOn', 'amount', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof RenewalUpcomingVariables> = [
  'appName',
  'tenantName',
  'renewsOn',
  'amount',
  'billingLink',
]

/**
 * Render the renewal upcoming email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `RenewalUpcomingVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderRenewalUpcomingTemplate(variables: RenewalUpcomingVariables): RenderedEmail {
  const { appName, tenantName, renewsOn, amount, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    RENEWAL_UPCOMING_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: RENEWAL_UPCOMING_TEMPLATE_KEY,
    subject: `Your yearly plan renews on ${renewsOn} for ₹${amount}`,
    appName,
    paragraphs: [
      `${tenantName} renews on Paid on ${renewsOn}, for ₹${amount}.`,
      `To stop it, cancel before ${renewsOn} from Billing.`,
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
