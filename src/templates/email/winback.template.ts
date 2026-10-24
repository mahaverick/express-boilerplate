/**
 * @file The win-back message, sent a week and a month after a workspace falls
 * to Free: one fact about what Free limits, and one button. Its one link opens
 * a page in the customer app and carries no token, so it mails from the
 * general sender.
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
export const WINBACK_TEMPLATE_KEY = 'winback' satisfies EmailTemplateKey

/**
 * The variables `renderWinbackTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface WinbackVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * Free's member limit, as digits.
   */
  memberLimit: string
  /**
   * Paid's monthly price in rupees, formatted, without the sign.
   */
  monthlyPrice: string
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
export const WINBACK_TEMPLATE_META: EmailTemplateMeta<WinbackVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'memberLimit', 'monthlyPrice', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof WinbackVariables> = [
  'appName',
  'tenantName',
  'memberLimit',
  'monthlyPrice',
  'billingLink',
]

/**
 * Render the winback email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `WinbackVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderWinbackTemplate(variables: WinbackVariables): RenderedEmail {
  const { appName, tenantName, memberLimit, monthlyPrice, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    WINBACK_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: WINBACK_TEMPLATE_KEY,
    subject: `Paid is still here for your ${appName} workspace`,
    appName,
    paragraphs: [
      `${tenantName} is on Free, which allows ${countOf(memberLimit, 'member')}.`,
      `Paid has no member limit, for ₹${monthlyPrice} a month.`,
    ],
    button: { label: 'Upgrade to Paid', link: billingLink },
  })
}
