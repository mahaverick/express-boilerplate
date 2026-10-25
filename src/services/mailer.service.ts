/**
 * @file Renders, sends and records one email. `sendMail` does not reject for a
 * render or send failure: it records the attempt in `email_logs` and returns
 * `'sent'` or `'failed'`, which the email worker reads to decide whether
 * BullMQ retries.
 */
import { getEnv } from '@/configs/env.config'
import { getMailTransporter } from '@/configs/mailer.config'
import { UNKNOWN_ERROR_CODE, type NewEmailLog } from '@/database/models/email-log.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { stackFrameLinesOf } from '@/errors/stack-frames'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { logger } from '@/services/logger.service'
import { EMAIL_TEMPLATE_META } from '@/templates/email/email-template-meta.template'
import {
  INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY,
  renderIntervalSwitchScheduledTemplate,
  type IntervalSwitchScheduledVariables,
} from '@/templates/email/interval-switch-scheduled.template'
import {
  INVITATION_CONFIRM_TEMPLATE_KEY,
  renderInvitationConfirmTemplate,
  type InvitationConfirmVariables,
} from '@/templates/email/invitation-confirm.template'
import {
  MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY,
  renderMaintenanceModeChangedTemplate,
  type MaintenanceModeChangedVariables,
} from '@/templates/email/maintenance-mode-changed.template'
import {
  MOVED_TO_FREE_TEMPLATE_KEY,
  renderMovedToFreeTemplate,
  type MovedToFreeVariables,
} from '@/templates/email/moved-to-free.template'
import {
  ONBOARDING_REMINDER_TEMPLATE_KEY,
  renderOnboardingReminderTemplate,
  type OnboardingReminderVariables,
} from '@/templates/email/onboarding-reminder.template'
import {
  PAID_CANCELLED_TEMPLATE_KEY,
  renderPaidCancelledTemplate,
  type PaidCancelledVariables,
} from '@/templates/email/paid-cancelled.template'
import {
  PAID_WELCOME_TEMPLATE_KEY,
  renderPaidWelcomeTemplate,
  type PaidWelcomeVariables,
} from '@/templates/email/paid-welcome.template'
import {
  PASSKEY_CREATED_TEMPLATE_KEY,
  renderPasskeyCreatedTemplate,
  type PasskeySecurityVariables,
} from '@/templates/email/passkey-created.template'
import {
  PASSKEY_DELETED_TEMPLATE_KEY,
  renderPasskeyDeletedTemplate,
} from '@/templates/email/passkey-deleted.template'
import {
  PAYER_LEFT_TEMPLATE_KEY,
  renderPayerLeftTemplate,
  type PayerLeftVariables,
} from '@/templates/email/payer-left.template'
import {
  PAYMENT_FAILED_TEMPLATE_KEY,
  renderPaymentFailedTemplate,
  type PaymentFailedVariables,
} from '@/templates/email/payment-failed.template'
import {
  RENEWAL_UPCOMING_TEMPLATE_KEY,
  renderRenewalUpcomingTemplate,
  type RenewalUpcomingVariables,
} from '@/templates/email/renewal-upcoming.template'
import {
  renderSignInLinkTemplate,
  SIGN_IN_LINK_TEMPLATE_KEY,
  type SignInLinkVariables,
} from '@/templates/email/sign-in-link.template'
import {
  renderStepUpLinkTemplate,
  STEP_UP_LINK_TEMPLATE_KEY,
  type StepUpLinkVariables,
} from '@/templates/email/step-up-link.template'
import {
  renderTenantInvitationTemplate,
  TENANT_INVITATION_TEMPLATE_KEY,
  type TenantInvitationVariables,
} from '@/templates/email/tenant-invitation.template'
import {
  TRIAL_ENDED_TEMPLATE_KEY,
  renderTrialEndedTemplate,
  type TrialEndedVariables,
} from '@/templates/email/trial-ended.template'
import {
  TRIAL_ENDING_TEMPLATE_KEY,
  renderTrialEndingTemplate,
  type TrialEndingVariables,
} from '@/templates/email/trial-ending.template'
import {
  TRIAL_ENDS_TODAY_TEMPLATE_KEY,
  renderTrialEndsTodayTemplate,
  type TrialEndsTodayVariables,
} from '@/templates/email/trial-ends-today.template'
import {
  TRIAL_MIDPOINT_TEMPLATE_KEY,
  renderTrialMidpointTemplate,
  type TrialMidpointVariables,
} from '@/templates/email/trial-midpoint.template'
import {
  TRIAL_STARTED_TEMPLATE_KEY,
  renderTrialStartedTemplate,
  type TrialStartedVariables,
} from '@/templates/email/trial-started.template'
import {
  UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY,
  renderUpgradeRequestFulfilledTemplate,
  type UpgradeRequestFulfilledVariables,
} from '@/templates/email/upgrade-request-fulfilled.template'
import {
  UPGRADE_REQUESTED_TEMPLATE_KEY,
  renderUpgradeRequestedTemplate,
  type UpgradeRequestedVariables,
} from '@/templates/email/upgrade-requested.template'
import {
  renderWelcomeTemplate,
  WELCOME_TEMPLATE_KEY,
  type WelcomeVariables,
} from '@/templates/email/welcome.template'
import {
  WINBACK_TEMPLATE_KEY,
  renderWinbackTemplate,
  type WinbackVariables,
} from '@/templates/email/winback.template'
import { senderFor } from '@/utilities/email-sender.utilities'
import type { RenderedEmail } from '@/utilities/email-template.utilities'

const emailLogRepository = new EmailLogRepository()

/**
 * One outbound email, identified by its template key and that template's own
 * variables, never by pre-rendered content. A discriminated union on
 * `templateKey`, so a key cannot be paired with another template's variables
 * and the logged key always names the content sent.
 *
 * There is no `subject`, `text` or `html`: `renderForMessage` produces them, so
 * a caller has no message field to put a token into. The one gap is
 * `variables.appName`, a plain string every template interpolates into its
 * subject. Keep caller-supplied `subject`/`text`/`html` out of this type.
 */
export type MailMessage =
  | {
      to: string
      templateKey: typeof TENANT_INVITATION_TEMPLATE_KEY
      variables: TenantInvitationVariables
    }
  | {
      to: string
      templateKey: typeof ONBOARDING_REMINDER_TEMPLATE_KEY
      variables: OnboardingReminderVariables
    }
  | {
      to: string
      templateKey: typeof MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY
      variables: MaintenanceModeChangedVariables
    }
  | {
      to: string
      templateKey: typeof SIGN_IN_LINK_TEMPLATE_KEY
      variables: SignInLinkVariables
    }
  | {
      to: string
      templateKey: typeof STEP_UP_LINK_TEMPLATE_KEY
      variables: StepUpLinkVariables
    }
  | {
      to: string
      templateKey: typeof WELCOME_TEMPLATE_KEY
      variables: WelcomeVariables
    }
  | {
      to: string
      templateKey: typeof INVITATION_CONFIRM_TEMPLATE_KEY
      variables: InvitationConfirmVariables
    }
  | {
      to: string
      templateKey: typeof PASSKEY_CREATED_TEMPLATE_KEY
      variables: PasskeySecurityVariables
    }
  | {
      to: string
      templateKey: typeof PASSKEY_DELETED_TEMPLATE_KEY
      variables: PasskeySecurityVariables
    }
  | {
      to: string
      templateKey: typeof TRIAL_STARTED_TEMPLATE_KEY
      variables: TrialStartedVariables
    }
  | {
      to: string
      templateKey: typeof TRIAL_MIDPOINT_TEMPLATE_KEY
      variables: TrialMidpointVariables
    }
  | {
      to: string
      templateKey: typeof TRIAL_ENDING_TEMPLATE_KEY
      variables: TrialEndingVariables
    }
  | {
      to: string
      templateKey: typeof TRIAL_ENDS_TODAY_TEMPLATE_KEY
      variables: TrialEndsTodayVariables
    }
  | {
      to: string
      templateKey: typeof TRIAL_ENDED_TEMPLATE_KEY
      variables: TrialEndedVariables
    }
  | {
      to: string
      templateKey: typeof PAID_WELCOME_TEMPLATE_KEY
      variables: PaidWelcomeVariables
    }
  | {
      to: string
      templateKey: typeof RENEWAL_UPCOMING_TEMPLATE_KEY
      variables: RenewalUpcomingVariables
    }
  | {
      to: string
      templateKey: typeof PAYMENT_FAILED_TEMPLATE_KEY
      variables: PaymentFailedVariables
    }
  | {
      to: string
      templateKey: typeof MOVED_TO_FREE_TEMPLATE_KEY
      variables: MovedToFreeVariables
    }
  | {
      to: string
      templateKey: typeof PAID_CANCELLED_TEMPLATE_KEY
      variables: PaidCancelledVariables
    }
  | {
      to: string
      templateKey: typeof INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY
      variables: IntervalSwitchScheduledVariables
    }
  | {
      to: string
      templateKey: typeof PAYER_LEFT_TEMPLATE_KEY
      variables: PayerLeftVariables
    }
  | {
      to: string
      templateKey: typeof UPGRADE_REQUESTED_TEMPLATE_KEY
      variables: UpgradeRequestedVariables
    }
  | {
      to: string
      templateKey: typeof UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY
      variables: UpgradeRequestFulfilledVariables
    }
  | {
      to: string
      templateKey: typeof WINBACK_TEMPLATE_KEY
      variables: WinbackVariables
    }

/**
 * The tracked message one send attempt belongs to: its `email_messages` id,
 * recorded on the attempt's `email_logs` row, and the Message-ID header it
 * goes out with, which a provider's events report back.
 */
export interface TrackedDelivery {
  messageId: string
  messageIdHeader: string
}

/**
 * Render `message` against its own declared template: the only place this
 * module produces content, used by `sendMail` and by the staff preview
 * (platform-email.service.ts), which renders stored variables with masked
 * links and never sends. A `switch`, not a lookup object, so TypeScript
 * narrows `message.variables` in each `case`.
 *
 * The `default` case is reachable by a caller that bypasses the type
 * (`as unknown as MailMessage`). It throws explicitly, so `sendMail`'s catch
 * handles it like any other rendering failure instead of a later TypeError.
 * @param message - The email to render.
 * @returns The rendered subject, text, and HTML for `message`'s own template.
 * @throws {Error} When `message.variables` is missing a value its template requires (`requireEmailVariables`, email-template.utilities.ts), or when `message.templateKey` matches no known template (only reachable by bypassing `MailMessage`'s own type).
 */
export function renderForMessage(message: MailMessage): RenderedEmail {
  switch (message.templateKey) {
    case TENANT_INVITATION_TEMPLATE_KEY: {
      return renderTenantInvitationTemplate(message.variables)
    }
    case ONBOARDING_REMINDER_TEMPLATE_KEY: {
      return renderOnboardingReminderTemplate(message.variables)
    }
    case MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY: {
      return renderMaintenanceModeChangedTemplate(message.variables)
    }
    case SIGN_IN_LINK_TEMPLATE_KEY: {
      return renderSignInLinkTemplate(message.variables)
    }
    case STEP_UP_LINK_TEMPLATE_KEY: {
      return renderStepUpLinkTemplate(message.variables)
    }
    case WELCOME_TEMPLATE_KEY: {
      return renderWelcomeTemplate(message.variables)
    }
    case INVITATION_CONFIRM_TEMPLATE_KEY: {
      return renderInvitationConfirmTemplate(message.variables)
    }
    case PASSKEY_CREATED_TEMPLATE_KEY: {
      return renderPasskeyCreatedTemplate(message.variables)
    }
    case PASSKEY_DELETED_TEMPLATE_KEY: {
      return renderPasskeyDeletedTemplate(message.variables)
    }
    case TRIAL_STARTED_TEMPLATE_KEY: {
      return renderTrialStartedTemplate(message.variables)
    }
    case TRIAL_MIDPOINT_TEMPLATE_KEY: {
      return renderTrialMidpointTemplate(message.variables)
    }
    case TRIAL_ENDING_TEMPLATE_KEY: {
      return renderTrialEndingTemplate(message.variables)
    }
    case TRIAL_ENDS_TODAY_TEMPLATE_KEY: {
      return renderTrialEndsTodayTemplate(message.variables)
    }
    case TRIAL_ENDED_TEMPLATE_KEY: {
      return renderTrialEndedTemplate(message.variables)
    }
    case PAID_WELCOME_TEMPLATE_KEY: {
      return renderPaidWelcomeTemplate(message.variables)
    }
    case RENEWAL_UPCOMING_TEMPLATE_KEY: {
      return renderRenewalUpcomingTemplate(message.variables)
    }
    case PAYMENT_FAILED_TEMPLATE_KEY: {
      return renderPaymentFailedTemplate(message.variables)
    }
    case MOVED_TO_FREE_TEMPLATE_KEY: {
      return renderMovedToFreeTemplate(message.variables)
    }
    case PAID_CANCELLED_TEMPLATE_KEY: {
      return renderPaidCancelledTemplate(message.variables)
    }
    case INTERVAL_SWITCH_SCHEDULED_TEMPLATE_KEY: {
      return renderIntervalSwitchScheduledTemplate(message.variables)
    }
    case PAYER_LEFT_TEMPLATE_KEY: {
      return renderPayerLeftTemplate(message.variables)
    }
    case UPGRADE_REQUESTED_TEMPLATE_KEY: {
      return renderUpgradeRequestedTemplate(message.variables)
    }
    case UPGRADE_REQUEST_FULFILLED_TEMPLATE_KEY: {
      return renderUpgradeRequestFulfilledTemplate(message.variables)
    }
    case WINBACK_TEMPLATE_KEY: {
      return renderWinbackTemplate(message.variables)
    }
    default: {
      throw new Error(
        `Cannot render email: "${String((message as { templateKey: unknown }).templateKey)}" is not a known template key.`
      )
    }
  }
}

/**
 * The nodemailer `.code` a rejected send carries, or `UNKNOWN_ERROR_CODE`
 * when there is no string `.code`.
 *
 * Reads only `.code`, never `.message` or `.response`: a rejecting SMTP server
 * can quote the refused body back, and the templates put a sign-in or
 * invitation URL in that body. The code is not shape-checked here: the
 * repository replaces a wrong-shaped one, and the `error_code` column's CHECK
 * backs that up.
 * @param error - Whatever the transport call rejected with.
 * @returns The extracted code, or `UNKNOWN_ERROR_CODE`.
 */
export function extractErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return UNKNOWN_ERROR_CODE
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : UNKNOWN_ERROR_CODE
}

/**
 * The `at ...` call frames of an object-shaped error's stack, without the
 * message, as `stackFramesOf` (postgres-errors.ts) does: `error.stack` embeds
 * the message, which must not be logged, while the frames locate a real bug.
 *
 * A frame must have a V8 frame's shape and come after the message
 * (`stackFrameLinesOf`), not merely start with `at `: the server-controlled,
 * multi-line message could hold a line that starts with `at `, indented or
 * not, or one shaped like a whole frame.
 * @param error - The thrown or rejected value, already known to be object-shaped.
 * @returns The call frames, or undefined when there is no usable stack.
 */
function callFramesOf(error: object): string | undefined {
  const { stack, message } = error as { stack?: unknown; message?: unknown }
  if (typeof stack !== 'string') return undefined
  const frames = stackFrameLinesOf(stack, typeof message === 'string' ? message : undefined).join(
    '\n'
  )
  return frames === '' ? undefined : frames
}

/**
 * The safe-to-log subset of a rejected send's error. The log stream has no
 * CHECK backstop like `error_code`'s, so this excludes `.message` and
 * `.response` for the same reason `extractErrorCode` does, and keeps the stack
 * frames with the message stripped. Exported for unit tests.
 * @param error - Whatever the transport call rejected with.
 * @returns A redacted record when `error` is object-shaped; `error` itself otherwise (nothing to redact from a primitive).
 */
export function redactedMailErrorForLog(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error
  const candidate = error as {
    name?: unknown
    code?: unknown
    command?: unknown
    responseCode?: unknown
  }
  return {
    name: candidate.name,
    code: candidate.code,
    command: candidate.command,
    responseCode: candidate.responseCode,
    stack: callFramesOf(error),
  }
}

/**
 * Record one delivery attempt, never letting a failure to record escape: the
 * mail has already gone out or failed, and a throw would fail the job, so
 * BullMQ would retry it and, after a success, send a second email.
 *
 * A failed insert is logged at `logger.error` through `redactedForLog`
 * (postgres-errors.ts), because its bound parameters include the recipient's
 * address.
 * @param entry - The row to insert.
 */
async function recordDelivery(entry: NewEmailLog): Promise<void> {
  try {
    await emailLogRepository.record(entry)
  } catch (error) {
    logger.error('Failed to record email delivery log', { error: redactedForLog(error) })
  }
}

/**
 * Render, send, and record the outcome of one email. Does not reject for any
 * failure nodemailer or rendering produces (see this file's JSDoc for why).
 * Not absolute: the catch reads properties off the error and calls the
 * logger, so a poisoned getter or a broken log stream could still escape.
 *
 * Rendering runs inside the same try as the transport call, so a render
 * throw is recorded as a failed delivery with `UNKNOWN_ERROR_CODE`, like a
 * transport rejection, instead of escaping.
 *
 * The From address follows the template's sender class
 * (`EMAIL_TEMPLATE_META`, `senderFor`), never the caller: a token email
 * always goes out from the transactional sender.
 *
 * Recording has its own try/catch (`recordDelivery`), not one shared with the
 * send, so a log-write failure after a successful send is never recorded as a
 * failed send. Response latency never waits on SMTP: every send runs from the
 * queue in email.worker.ts. When mail is down the user gets no email and no
 * error; every attempt is in `email_logs`, and asking for a new link lets them retry.
 * @param message - The email to render and send.
 * @param delivery - The tracked message this attempt belongs to. Without it, nodemailer generates the Message-ID and the attempt row has no `message_id`.
 * @returns `'sent'` or `'failed'`, the attempt's status. Resolves once the send has been attempted and the outcome recorded, even if recording failed. `email.worker.ts` reads it to decide whether to retry.
 */
export async function sendMail(
  message: MailMessage,
  delivery?: TrackedDelivery
): Promise<'sent' | 'failed'> {
  const messageId = delivery?.messageId
  let entry: NewEmailLog
  try {
    // Inside the try: a render throw is recorded as a failed delivery, like a transport rejection.
    const rendered = renderForMessage(message)
    const from = senderFor(EMAIL_TEMPLATE_META[rendered.templateKey].senderClass, getEnv())
    const info = await getMailTransporter().sendMail({
      from,
      to: message.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(delivery !== undefined && { messageId: delivery.messageIdHeader }),
    })
    entry = {
      recipient: message.to,
      templateKey: rendered.templateKey,
      status: 'sent',
      providerMessageId: info.messageId,
      messageId,
    }
  } catch (error) {
    logger.error('Mail send failed', { error: redactedMailErrorForLog(error) })
    entry = {
      recipient: message.to,
      templateKey: message.templateKey,
      status: 'failed',
      errorCode: extractErrorCode(error),
      messageId,
    }
  }
  await recordDelivery(entry)
  return entry.status === 'sent' ? 'sent' : 'failed'
}
