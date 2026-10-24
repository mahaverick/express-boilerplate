/**
 * @file The "your workspace needs a new card" message, sent to the other
 * owners when the owner who paid leaves. The payer's name is another person's,
 * so it is never stored or put in the subject. Its one link opens a page in
 * the customer app and carries no token, so it mails from the general sender.
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
export const PAYER_LEFT_TEMPLATE_KEY = 'payer_left' satisfies EmailTemplateKey

/**
 * The variables `renderPayerLeftTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface PayerLeftVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * The name of the owner who paid and left.
   */
  payerName: string
  /**
   * When the payer left, as a date in the workspace's time zone.
   */
  leftOn: string
  /**
   * The subscription's state: `active` while it still charges the payer's
   * card, `past_due` after a payment failed. Any other value reads as
   * `past_due`.
   */
  billingState: string
  /**
   * A date in the workspace's time zone: the renewal date while the
   * subscription is active, or the last day the workspace keeps Paid without
   * a new card after a failed payment (the end of grace).
   */
  periodEndsOn: string
  /**
   * The workspace's Billing page. Named `…Link`, not `…Url`: it carries no
   * token, so it is stored and previewed.
   */
  billingLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender.
 * `payerName` is not stored: it is another person's name, which that
 * person's purge could not find here. Never resent.
 */
export const PAYER_LEFT_TEMPLATE_META: EmailTemplateMeta<PayerLeftVariables> = {
  senderClass: 'general',
  previewVariables: [
    'appName',
    'tenantName',
    'leftOn',
    'billingState',
    'periodEndsOn',
    'billingLink',
  ],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PayerLeftVariables> = [
  'appName',
  'tenantName',
  'payerName',
  'leftOn',
  'billingState',
  'periodEndsOn',
  'billingLink',
]

/**
 * What the owners are asked to do once the payer left: while the
 * subscription is active it still charges the payer's card until it renews,
 * so they move the payment method to their own; after a failed payment Paid
 * ends with grace, so they add a card by then.
 * @param billingState - The subscription's state.
 * @param tenantName - The workspace's display name.
 * @param periodEndsOn - The renewal date, or the end of grace.
 * @returns The sentences.
 */
export function payerLeftNextStep(
  billingState: string,
  tenantName: string,
  periodEndsOn: string
): string {
  return billingState === 'active'
    ? `The subscription still charges their card. It renews on ${periodEndsOn}. To pay with your card, update the payment method in Billing.`
    : `Add your card by ${periodEndsOn} to keep Paid. After that, ${tenantName} moves to Free.`
}

/**
 * Render the payer left email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `PayerLeftVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPayerLeftTemplate(variables: PayerLeftVariables): RenderedEmail {
  const { appName, tenantName, payerName, leftOn, billingState, periodEndsOn, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, PAYER_LEFT_TEMPLATE_KEY)
  return renderBillingEmail({
    templateKey: PAYER_LEFT_TEMPLATE_KEY,
    subject: `Your ${appName} workspace needs a new card`,
    appName,
    paragraphs: [
      `${payerName} paid for Paid and left ${tenantName} on ${leftOn}.`,
      payerLeftNextStep(billingState, tenantName, periodEndsOn),
    ],
    button: {
      label: billingState === 'active' ? 'Update payment method' : 'Add your card',
      link: billingLink,
    },
  })
}
