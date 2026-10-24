/**
 * @file The "your workspace is on Paid now" message, sent to a member whose
 * upgrade request an owner's upgrade fulfilled. Its link opens the workspace's
 * home. Its one link opens a page in the customer app and carries no token, so
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
export const UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY =
  'upgrade_request_fulfilled' satisfies EmailTemplateKey

/**
 * The variables `renderUpgradeRequestFulfilledTemplate` needs. All are required strings:
 * `requireEmailVariables` rejects anything else at runtime.
 */
export interface UpgradeRequestFulfilledVariables {
  /**
   * The product name, for the subject and the sign-off.
   */
  appName: string
  /**
   * The workspace's display name.
   */
  tenantName: string
  /**
   * The workspace's home page. Named `…Link`, not `…Url`: it carries no token,
   * so it is stored and previewed.
   */
  tenantLink: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored for the preview. Never resent.
 */
export const UPGRADE_REQUEST_FULFILLED_TEMPLATE_META: EmailTemplateMeta<UpgradeRequestFulfilledVariables> =
  {
    senderClass: 'general',
    previewVariables: ['appName', 'tenantName', 'tenantLink'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof UpgradeRequestFulfilledVariables> = [
  'appName',
  'tenantName',
  'tenantLink',
]

/**
 * Render the upgrade request fulfilled email: plain-text and HTML parts with one
 * button, every value escaped in the HTML part.
 * @param variables - See `UpgradeRequestFulfilledVariables`.
 * @returns The rendered subject, text and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderUpgradeRequestFulfilledTemplate(
  variables: UpgradeRequestFulfilledVariables
): RenderedEmail {
  const { appName, tenantName, tenantLink } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY
  )
  return renderBillingEmail({
    templateKey: UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY,
    subject: `Your ${appName} workspace is on Paid now`,
    appName,
    paragraphs: [
      `You asked to move ${tenantName} to Paid. An owner upgraded it.`,
      'Everything in Paid is on for you.',
    ],
    button: { label: 'Open your workspace', link: tenantLink },
  })
}
