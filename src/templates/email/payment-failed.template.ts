/**
 * @file The "your payment failed" message, sent once, when the provider halts
 * the subscription: the amount and the last day to update the card (the payment method, for a pause). Its one
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
   * What stopped the payments: `halted` when a payment failed and the
   * provider stopped retrying, `paused` when the payer paused the
   * subscription from their bank or UPI app. Any other value reads as
   * `halted`.
   */
  stoppedBy: string
  /**
   * The last day to update the card or payment method, as a date in the workspace's time zone.
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
  previewVariables: ['appName', 'tenantName', 'amount', 'stoppedBy', 'graceEndsOn', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PaymentFailedVariables> = [
  'appName',
  'tenantName',
  'amount',
  'stoppedBy',
  'graceEndsOn',
  'billingLink',
]

/**
 * Render the payment failed email, or its paused variant: plain-text and
 * HTML parts with one button, every value escaped in the HTML part. Both keep
 * the same next step and Free date.
 * @param variables - See `PaymentFailedVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPaymentFailedTemplate(variables: PaymentFailedVariables): RenderedEmail {
  const { appName, tenantName, amount, stoppedBy, graceEndsOn, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, PAYMENT_FAILED_TEMPLATE_KEY)
  const isPaused = stoppedBy === 'paused'
  return renderBillingEmail({
    templateKey: PAYMENT_FAILED_TEMPLATE_KEY,
    subject: isPaused ? 'Your Paid subscription is paused' : `Your payment of ₹${amount} failed`,
    appName,
    paragraphs: [
      isPaused
        ? `Your subscription for ${tenantName} was paused from your bank or UPI app.`
        : `Your payment of ₹${amount} for ${tenantName} failed.`,
      `Update your ${isPaused ? 'payment method' : 'card'} by ${graceEndsOn} to keep Paid. After that, ${tenantName} moves to Free.`,
    ],
    // A pause comes from the bank or UPI app, so the payment method, not a card, needs updating.
    button: { label: isPaused ? 'Update payment method' : 'Update your card', link: billingLink },
  })
}
