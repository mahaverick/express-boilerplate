/**
 * @file The "a teammate asked to upgrade" message, sent to the owners. The
 * requester's name is another person's, so it is never stored or put in the
 * subject. Its one link opens a page in the customer app and carries no token,
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
export const UPGRADE_REQUESTED_TEMPLATE_KEY = 'upgrade_requested' satisfies EmailTemplateKey

/**
 * The variables `renderUpgradeRequestedTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface UpgradeRequestedVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * The name of the member who asked.
   */
  requesterName: string
  /**
   * Paid's monthly price in rupees, formatted, without the sign.
   */
  monthlyPrice: string
  /**
   * Paid's yearly price in rupees, formatted, without the sign.
   */
  yearlyPrice: string
  /**
   * The workspace's Billing page. Named `…Link`, not `…Url`: it carries no
   * token, so it is stored and previewed.
   */
  billingLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender.
 * `requesterName` is not stored: it is another person's name, which that
 * person's purge could not find here. Never resent.
 */
export const UPGRADE_REQUESTED_TEMPLATE_META: EmailTemplateMeta<UpgradeRequestedVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'monthlyPrice', 'yearlyPrice', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof UpgradeRequestedVariables> = [
  'appName',
  'tenantName',
  'requesterName',
  'monthlyPrice',
  'yearlyPrice',
  'billingLink',
]

/**
 * Render the upgrade requested email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `UpgradeRequestedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderUpgradeRequestedTemplate(
  variables: UpgradeRequestedVariables
): RenderedEmail {
  const { appName, tenantName, requesterName, monthlyPrice, yearlyPrice, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, UPGRADE_REQUESTED_TEMPLATE_KEY)
  return renderBillingEmail({
    templateKey: UPGRADE_REQUESTED_TEMPLATE_KEY,
    subject: `A teammate asked to upgrade your ${appName} workspace`,
    appName,
    paragraphs: [
      `${requesterName} asked you to move ${tenantName} to Paid.`,
      `Paid costs ₹${monthlyPrice} a month or ₹${yearlyPrice} a year. Upgrade from Billing.`,
    ],
    button: { label: 'Upgrade to Paid', link: billingLink },
  })
}
