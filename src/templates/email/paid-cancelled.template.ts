/**
 * @file The cancellation confirmation: when Paid ends, and how to keep it.
 * Its variant before the first charge says no charge was made and when the
 * trial ends. Its one link opens a page in the customer app and carries no
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
export const PAID_CANCELLED_TEMPLATE_KEY = 'paid_cancelled' satisfies EmailTemplateKey

/**
 * The variables `renderPaidCancelledTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface PaidCancelledVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * When Paid ends, as a date in the workspace's time zone; before the first
   * charge, when the trial ends.
   */
  endsOn: string
  /**
   * `true` when a deferred start was cancelled before its first charge, so
   * the workspace is back on its trial. Any other value reads as a cancel at
   * the end of a paid period.
   */
  beforeFirstCharge: string
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
export const PAID_CANCELLED_TEMPLATE_META: EmailTemplateMeta<PaidCancelledVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'endsOn', 'beforeFirstCharge', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof PaidCancelledVariables> = [
  'appName',
  'tenantName',
  'endsOn',
  'beforeFirstCharge',
  'billingLink',
]

/**
 * Render the paid cancelled email, or its variant before the first charge:
 * plain-text and HTML parts with one button, every value escaped in the HTML
 * part.
 * @param variables - See `PaidCancelledVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderPaidCancelledTemplate(variables: PaidCancelledVariables): RenderedEmail {
  const { appName, tenantName, endsOn, beforeFirstCharge, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    PAID_CANCELLED_TEMPLATE_KEY
  )
  if (beforeFirstCharge === 'true') {
    return renderBillingEmail({
      templateKey: PAID_CANCELLED_TEMPLATE_KEY,
      subject: `Your ${appName} Paid plan is cancelled`,
      appName,
      paragraphs: [
        `Paid for ${tenantName} was cancelled before its first charge, so no payment was taken.`,
        `Your trial continues until ${endsOn}.`,
        'To keep Paid after that, upgrade again in Billing.',
      ],
      button: { label: 'Open Billing', link: billingLink },
    })
  }
  return renderBillingEmail({
    templateKey: PAID_CANCELLED_TEMPLATE_KEY,
    subject: `Paid ends on ${endsOn}`,
    appName,
    paragraphs: [
      `${tenantName} keeps Paid until ${endsOn}, then moves to Free.`,
      "You won't be charged again.",
      'To keep Paid, subscribe again from Billing.',
    ],
    button: { label: 'Open Billing', link: billingLink },
  })
}
