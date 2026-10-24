/**
 * @file The "your payment failed" message, sent once, when the provider halts
 * the subscription: the amount and the last day to update the card. Its one
 * link opens a page in the customer app and carries no token, so it mails from
 * the general sender.
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
export const PAYMENT_FAILED_TEMPLATE_KEY = 'payment_failed' satisfies EmailTemplateKey

/**
 * The variables `renderPaymentFailedTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface PaymentFailedVariables {
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
   * The last day to update the card, as a date in the workspace's time zone.
   */
  graceEndsOn: string
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
export const PAYMENT_FAILED_TEMPLATE_META: EmailTemplateMeta<PaymentFailedVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'amount', 'graceEndsOn', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PaymentFailedVariables> = [
  'appName',
  'tenantName',
  'amount',
  'graceEndsOn',
  'billingLink',
]

/**
 * Render the payment failed email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `PaymentFailedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPaymentFailedTemplate(variables: PaymentFailedVariables): RenderedEmail {
  const { appName, tenantName, amount, graceEndsOn, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    PAYMENT_FAILED_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: PAYMENT_FAILED_TEMPLATE_KEY,
    subject: `Your payment of ₹${amount} failed`,
    appName,
    paragraphs: [
      `The payment of ₹${amount} for ${tenantName} on Paid failed.`,
      `Update your card by ${graceEndsOn} to keep Paid. After that, ${tenantName} moves to Free.`,
    ],
    button: { label: 'Update your card', link: billingLink },
  })
}
