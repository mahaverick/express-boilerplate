/**
 * @file Renders, sends and records one email. `sendMail` never lets a send
 * failure reach its caller: register, resend-verification and forgot-password
 * answer identically whether or not the address exists, and a propagated failure
 * would turn an SMTP outage into an account-enumeration oracle.
 */
import { getEnv } from '@/configs/env.config'
import { getMailTransporter } from '@/configs/mailer.config'
import { UNKNOWN_ERROR_CODE, type NewEmailLog } from '@/database/models/email-log.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { logger } from '@/services/logger.service'
import {
  ACCOUNT_SETUP_TEMPLATE_KEY,
  renderAccountSetupTemplate,
  type AccountSetupVariables,
} from '@/templates/email/account-setup.template'
import { EMAIL_TEMPLATE_META } from '@/templates/email/email-template-meta.template'
import {
  EMAIL_VERIFICATION_TEMPLATE_KEY,
  renderEmailVerificationTemplate,
  type EmailVerificationVariables,
} from '@/templates/email/email-verification.template'
import {
  PASSWORD_CHANGED_TEMPLATE_KEY,
  renderPasswordChangedTemplate,
  type PasswordChangedVariables,
} from '@/templates/email/password-changed.template'
import {
  PASSWORD_RESET_TEMPLATE_KEY,
  renderPasswordResetTemplate,
  type PasswordResetVariables,
} from '@/templates/email/password-reset.template'
import {
  REGISTRATION_ATTEMPT_TEMPLATE_KEY,
  renderRegistrationAttemptTemplate,
  type RegistrationAttemptVariables,
} from '@/templates/email/registration-attempt.template'
import {
  renderTenantInvitationTemplate,
  TENANT_INVITATION_TEMPLATE_KEY,
  type TenantInvitationVariables,
} from '@/templates/email/tenant-invitation.template'
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
 * `variables.appName`, a plain string interpolated into the registration-attempt
 * subject. Do not add caller-supplied `subject`/`text`/`html` back.
 */
export type MailMessage =
  | {
      to: string
      templateKey: typeof EMAIL_VERIFICATION_TEMPLATE_KEY
      variables: EmailVerificationVariables
    }
  | {
      to: string
      templateKey: typeof PASSWORD_RESET_TEMPLATE_KEY
      variables: PasswordResetVariables
    }
  | {
      to: string
      templateKey: typeof REGISTRATION_ATTEMPT_TEMPLATE_KEY
      variables: RegistrationAttemptVariables
    }
  | {
      to: string
      templateKey: typeof PASSWORD_CHANGED_TEMPLATE_KEY
      variables: PasswordChangedVariables
    }
  | {
      to: string
      templateKey: typeof TENANT_INVITATION_TEMPLATE_KEY
      variables: TenantInvitationVariables
    }
  | {
      to: string
      templateKey: typeof ACCOUNT_SETUP_TEMPLATE_KEY
      variables: AccountSetupVariables
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
 * module produces content. A `switch`, not a lookup object, so TypeScript
 * narrows `message.variables` in each `case`.
 *
 * The `default` case is reachable by a caller that bypasses the type
 * (`as unknown as MailMessage`). It throws explicitly, so `sendMail`'s catch
 * handles it like any other rendering failure instead of a later TypeError.
 * @param message - The email to render.
 * @returns The rendered subject, text, and HTML for `message`'s own template.
 * @throws {Error} When `message.variables` is missing a value its template requires (`requireEmailVariables`, email-template.utilities.ts), or when `message.templateKey` matches no known template (only reachable by bypassing `MailMessage`'s own type).
 */
function renderForMessage(message: MailMessage): RenderedEmail {
  switch (message.templateKey) {
    case EMAIL_VERIFICATION_TEMPLATE_KEY: {
      return renderEmailVerificationTemplate(message.variables)
    }
    case PASSWORD_RESET_TEMPLATE_KEY: {
      return renderPasswordResetTemplate(message.variables)
    }
    case REGISTRATION_ATTEMPT_TEMPLATE_KEY: {
      return renderRegistrationAttemptTemplate(message.variables)
    }
    case PASSWORD_CHANGED_TEMPLATE_KEY: {
      return renderPasswordChangedTemplate(message.variables)
    }
    case TENANT_INVITATION_TEMPLATE_KEY: {
      return renderTenantInvitationTemplate(message.variables)
    }
    case ACCOUNT_SETUP_TEMPLATE_KEY: {
      return renderAccountSetupTemplate(message.variables)
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
 * when there isn't one shaped like a code.
 *
 * Reads only `.code`, never `.message` or `.response`: a rejecting SMTP server
 * can quote the refused body back, and the templates put a reset or
 * verification URL in that body. The `error_code` column's CHECK is a backstop,
 * not what this relies on.
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
 * Matches `/^\s+at /`, not a trimmed `startsWith('at ')`: V8 indents every real
 * frame, and the server-controlled, multi-line message could start a line with
 * `at ` to survive a check that drops the indentation.
 * @param error - The thrown or rejected value, already known to be object-shaped.
 * @returns The call frames, or undefined when there is no usable stack.
 */
function callFramesOf(error: object): string | undefined {
  const { stack } = error as { stack?: unknown }
  if (typeof stack !== 'string') return undefined
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n')
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
 * mail has already gone out or failed, and a 500 would make the caller retry
 * and, after a success, send a second email.
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
 * Render, send, and record the outcome of one email. Never rejects for any
 * failure nodemailer or rendering produces (see this file's JSDoc for why). Not
 * absolute: the catch reads properties off the error and calls the logger, so
 * a poisoned getter or a broken log stream could still escape.
 *
 * Rendering runs inside the same try as the transport call. A template
 * variable present only for a registered user would otherwise throw outside
 * the catch and turn "does this address have an account?" into a 500-vs-200
 * question; a render throw is recorded as a failed delivery with
 * `UNKNOWN_ERROR_CODE`, like a transport rejection.
 *
 * The From address follows the template's sender class
 * (`EMAIL_TEMPLATE_META`, `senderFor`), never the caller: a token email
 * always goes out from the transactional sender.
 *
 * Recording has its own try/catch (`recordDelivery`), not one shared with the
 * send, so a log-write failure after a successful send is never recorded as a
 * failed send. Response latency never waits on SMTP: every send runs from the
 * queue in email.worker.ts. When mail is down the user gets no email and no
 * error; every attempt is in `email_logs`, and resend-verification lets them retry.
 * @param message - The email to render and send.
 * @param delivery - The tracked message this attempt belongs to. Without it, nodemailer generates the Message-ID and the attempt row has no `message_id`.
 * @returns `'sent'` or `'failed'`, reflecting the recorded `email_logs` status — resolves once the send has been attempted and the outcome recorded, regardless of whether rendering, sending, or recording actually succeeded. Callers that need to decide whether to retry (e.g. `email.worker.ts`) read this; callers that don't can ignore it.
 */
export async function sendMail(
  message: MailMessage,
  delivery?: TrackedDelivery
): Promise<'sent' | 'failed'> {
  const messageId = delivery?.messageId
  let entry: NewEmailLog
  try {
    // Inside the try: a render throw must not reveal which branch an enumeration-sensitive caller took.
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
