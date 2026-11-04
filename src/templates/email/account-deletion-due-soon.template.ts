/**
 * @file The staff alert for an account deletion request due within five
 * days, to every platform admin: the date to complete it by. The daily
 * due-soon run sends it once per request. It names no customer and carries
 * no token or link; its variables hold no secret.
 */
import {
  escapeHtmlForEmail,
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
export const ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY =
  'account_deletion_due_soon' satisfies EmailTemplateKey

/**
 * The mail's subject, also the in-app notification's title.
 */
export const ACCOUNT_DELETION_DUE_SOON_TITLE = 'Account deletion due within 5 days'

/**
 * The variables `renderAccountDeletionDueSoonTemplate` needs. All are
 * required strings: `requireEmailVariables` rejects anything else at runtime.
 */
export interface AccountDeletionDueSoonVariables {
  firstName: string
  appName: string
  /**
   * When the deletion is due, from `formatUtcDateTime`.
   */
  dueAt: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored. Never resent: the run alerts once per
 * request.
 */
export const ACCOUNT_DELETION_DUE_SOON_TEMPLATE_META: EmailTemplateMeta<AccountDeletionDueSoonVariables> =
  {
    senderClass: 'general',
    previewVariables: ['firstName', 'appName', 'dueAt'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountDeletionDueSoonVariables> = [
  'firstName',
  'appName',
  'dueAt',
]

/**
 * The alert's one-line summary, shared with the in-app notification's body
 * so the two never drift.
 * @param dueAt - When the deletion is due, from `formatUtcDateTime`.
 * @returns The summary.
 */
export function accountDeletionDueSoonSummary(dueAt: string): string {
  return `A customer's account deletion is due by ${dueAt}. Complete it in Deletion requests before then.`
}

/**
 * Render the due-soon alert: plain-text and HTML parts naming the due date.
 * @param variables - See `AccountDeletionDueSoonVariables`.
 * @returns The rendered subject, text, and HTML, plus this template's key.
 * @throws {Error} When any required variable is missing — see `requireEmailVariables`.
 */
export function renderAccountDeletionDueSoonTemplate(
  variables: AccountDeletionDueSoonVariables
): RenderedEmail {
  const { firstName, appName, dueAt } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY
  )

  const summary = accountDeletionDueSoonSummary(dueAt)
  const why = 'You are receiving this because you are a platform admin. Find the request in Apex.'

  const text = [`Hi ${firstName},`, '', summary, '', why, '', `— The ${appName} team`].join('\n')

  const html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; line-height: 1.5;">
    <p>Hi ${escapeHtmlForEmail(firstName)},</p>
    <p>${escapeHtmlForEmail(summary)}</p>
    <p>${why}</p>
    <p>— The ${escapeHtmlForEmail(appName)} team</p>
  </body>
</html>`

  return {
    templateKey: ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY,
    subject: ACCOUNT_DELETION_DUE_SOON_TITLE,
    text,
    html,
  }
}
