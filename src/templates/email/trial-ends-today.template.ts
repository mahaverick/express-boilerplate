/**
 * @file The trial's last-day message: what Free allows against what the
 * workspace has, and the prices. Its one link opens a page in the customer app
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
export const TRIAL_ENDS_TODAY_TEMPLATE_KEY = 'trial_ends_today' satisfies EmailTemplateKey

/**
 * The variables `renderTrialEndsTodayTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface TrialEndsTodayVariables {
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
   * The members the workspace has, pending invitations included, as digits.
   */
  membersUsed: string
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
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored for the preview. Never resent.
 */
export const TRIAL_ENDS_TODAY_TEMPLATE_META: EmailTemplateMeta<TrialEndsTodayVariables> = {
  senderClass: 'general',
  previewVariables: [
    'appName',
    'tenantName',
    'memberLimit',
    'membersUsed',
    'monthlyPrice',
    'yearlyPrice',
    'billingLink',
  ],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof TrialEndsTodayVariables> = [
  'appName',
  'tenantName',
  'memberLimit',
  'membersUsed',
  'monthlyPrice',
  'yearlyPrice',
  'billingLink',
]

/**
 * Render the trial ends today email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `TrialEndsTodayVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderTrialEndsTodayTemplate(variables: TrialEndsTodayVariables): RenderedEmail {
  const { appName, tenantName, memberLimit, membersUsed, monthlyPrice, yearlyPrice, billingLink } =
    requireEmailVariables(variables, REQUIRED_VARIABLE_NAMES, TRIAL_ENDS_TODAY_TEMPLATE_KEY)
  return renderBillingEmail({
    templateKey: TRIAL_ENDS_TODAY_TEMPLATE_KEY,
    subject: 'Your Paid trial ends today',
    appName,
    paragraphs: [
      `Today ${tenantName} moves to Free. Free allows ${countOf(memberLimit, 'member')}; you have ${membersUsed}.`,
      `Upgrade to keep Paid: ₹${monthlyPrice} a month or ₹${yearlyPrice} a year.`,
    ],
    button: { label: 'Upgrade to Paid', link: billingLink },
  })
}
