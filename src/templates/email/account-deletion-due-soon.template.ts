/**
 * @file The staff alert for an account deletion request due within five
 * days, or overdue, to every platform owner and admin: the date to complete
 * it by. The daily due-soon run sends it once per request, and again about
 * every 30 days while it stays overdue. It names no customer and carries
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
export const ACCOUNT_DELETION_DUE_SOON_TITLE = 'Account deletion due or overdue'

/**
 * Whether the request was still ahead of its due date (`upcoming`) or past it
 * (`overdue`) when the alert was queued. A string, so tracking stores it and
 * the preview can fill it; any value but `overdue` reads as upcoming.
 */
export type AccountDeletionDueState = 'upcoming' | 'overdue'

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
  /**
   * See `AccountDeletionDueState`. Typed `string`, as the preview fills it
   * from stored text.
   */
  dueState: string
}

/**
 * How email tracking treats this template. No token, so the general sender,
 * and every variable is stored. Never resent: the run alerts once per
 * request.
 */
export const ACCOUNT_DELETION_DUE_SOON_TEMPLATE_META: EmailTemplateMeta<AccountDeletionDueSoonVariables> =
  {
    senderClass: 'general',
    previewVariables: ['firstName', 'appName', 'dueAt', 'dueState'],
    resendAction: null,
  }

const REQUIRED_VARIABLE_NAMES: ReadonlyArray<keyof AccountDeletionDueSoonVariables> = [
  'firstName',
  'appName',
  'dueAt',
  'dueState',
]

/**
 * The alert's one-line summary, shared with the in-app notification's body
 * so the two never drift. An overdue request reads as past due, with the
 * next step now.
 * @param dueAt - When the deletion is due, from `formatUtcDateTime`.
 * @param dueState - `overdue` once the due date has passed; see `AccountDeletionDueState`.
 * @returns The summary.
 */
export function accountDeletionDueSoonSummary(dueAt: string, dueState: string): string {
  if (dueState === 'overdue') {
    return `A customer's account deletion was due by ${dueAt}. Complete it in Deletion requests now.`
  }
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
  const { firstName, appName, dueAt, dueState } = requireEmailVariables(
    variables,
    REQUIRED_VARIABLE_NAMES,
    ACCOUNT_DELETION_DUE_SOON_TEMPLATE_KEY
  )

  const summary = accountDeletionDueSoonSummary(dueAt, dueState)
  const why =
    'You are receiving this because you are a platform owner or admin. Find the request in Apex.'

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
