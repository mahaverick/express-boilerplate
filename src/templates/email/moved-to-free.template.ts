/**
 * @file The "your workspace moved to Free" message, with one sentence on why:
 * a failed payment, a cancellation, our support team, or a suspension or
 * archive. Its one link opens a page in the customer app and carries no token,
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
 * Why a workspace moved to Free: its payment failed and grace ended, its
 * subscription was cancelled, our support team moved it, or it was suspended
 * or archived.
 */
type MovedToFreeCause = 'payment_failed' | 'cancelled' | 'staff' | 'lifecycle'

/**
 * The sentence each cause reads as.
 */
const CAUSE_SENTENCES: Readonly<Record<MovedToFreeCause, string>> = {
  payment_failed:
    'The payment for Paid failed, and the card was not updated before the grace period ended.',
  cancelled: 'Its Paid subscription was cancelled, and its paid period ended.',
  staff: 'Our support team moved it to Free.',
  lifecycle: 'Its subscription was cancelled because the workspace was suspended or archived.',
}

/**
 * The sentence for a cause. A cause this build doesn't know, such as a
 * preview's placeholder, reads as no sentence.
 * @param cause - The stored cause.
 * @returns The sentence, or an empty string.
 */
function causeSentence(cause: string): string {
  return Object.hasOwn(CAUSE_SENTENCES, cause) ? CAUSE_SENTENCES[cause as MovedToFreeCause] : ''
}

/**
 * This template's entry in `EMAIL_TEMPLATE_KEYS`. `satisfies`, not an
 * annotation, so it keeps the literal type that `MailMessage`'s union
 * narrows on.
 */
export const MOVED_TO_FREE_TEMPLATE_KEY = 'moved_to_free' satisfies EmailTemplateKey

/**
 * The variables `renderMovedToFreeTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface MovedToFreeVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * Why the workspace moved to Free: a `MovedToFreeCause`. A plain string, so
   * a preview can pass back what was stored; one this build doesn't know
   * reads as no sentence.
   */
  downgradeCause: string
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
export const MOVED_TO_FREE_TEMPLATE_META: EmailTemplateMeta<MovedToFreeVariables> = {
  senderClass: 'general',
  previewVariables: ['appName', 'tenantName', 'downgradeCause', 'billingLink'],
  resendAction: null,
}

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof MovedToFreeVariables> = [
  'appName',
  'tenantName',
  'downgradeCause',
  'billingLink',
]

/**
 * Render the moved to free email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `MovedToFreeVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderMovedToFreeTemplate(variables: MovedToFreeVariables): RenderedEmail {
  const { appName, tenantName, downgradeCause, billingLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    MOVED_TO_FREE_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: MOVED_TO_FREE_TEMPLATE_KEY,
    subject: `Your ${appName} workspace moved to Free`,
    appName,
    paragraphs: [
      `${tenantName} moved to Free. ${causeSentence(downgradeCause)}`.trimEnd(),
      'Nothing is deleted. To get Paid back, upgrade from Billing.',
    ],
    button: { label: 'Upgrade to Paid', link: billingLink },
  })
}
