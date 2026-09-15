// src/services/mailer.service.ts
//
// Ruling G (task-2-brief.md, "Controller addendum"): a mail-send failure
// must NEVER propagate to the caller. `sendMail` below is structured so
// that is true by construction, not by convention — read this comment
// before touching the control flow.
//
// WHY. Tasks 5/6 require `POST /auth/register`,
// `POST /auth/resend-verification`, and `POST /auth/forgot-password` to
// return byte-identical responses whether or not the address exists — the
// entire point of those tasks, closing the enumeration oracle B2 could only
// bound. `forgot-password` sends only when the user actually exists, so if
// a send failure propagated as a rejection here, an SMTP outage would
// become a perfect account-enumeration oracle the moment anyone is
// listening during one: a registered address throws, an unregistered one
// doesn't. The cost accepted for this ruling: when mail is down, a user
// gets no email and no error — mitigated by this function recording every
// attempt in the delivery log (below) and by `POST /auth/resend-verification`
// (Task 5) letting them retry once mail is back.
//
// TWO INDEPENDENT catches, not one wrapping both halves, on purpose:
//
//   1. The transport call (getMailTransporter().sendMail(...)) is the ONLY
//      thing the first try/catch guards. Its catch never re-throws — it
//      just decides which `NewEmailLog` to build.
//   2. `recordDelivery` has its OWN try/catch (Ruling E, task-4-brief.md: a
//      failed delivery-log write must not fail the send either — by the
//      time that write is attempted, the mail has already gone out one way
//      or the other, and a propagated error here would turn an operation
//      that already succeeded or failed into a 500 for a caller who then
//      retries and, on the success path, sends a second email).
//
// A single try/catch spanning both the send AND the record() call would
// make Ruling E accidentally depend on Ruling G's catch instead of standing
// on its own — if recordDelivery's own catch ever regressed, a log-write
// failure on the SUCCESS path would fall into the outer catch and get
// recorded as a FAILED send with a Postgres error code, which is simply
// wrong: the mail sent. Keeping them structurally separate means either one
// can be read, tested, and broken independently of the other.
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { getMailTransporter } from '@/configs/mailer.config'
import { UNKNOWN_ERROR_CODE, type NewEmailLog } from '@/database/models/email-log.model'
import { EmailLogRepository } from '@/repositories/email-log.repository'

const emailLogRepository = new EmailLogRepository()

/**
 * One outbound email's minimal content. Task 3 (templates) owns rendering
 * subject/text/html from a template and its variables; this service takes
 * whatever a caller already supplies and renders nothing itself.
 */
export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  templateKey: string
}

/**
 * The nodemailer `.code` a rejected send carries, or `UNKNOWN_ERROR_CODE`
 * when there isn't one shaped like a code.
 *
 * Reads ONLY `.code` — never `.message` or `.response`. Both of those
 * routinely echo content back from the SMTP server (a rejecting server can
 * quote the message body it refused), and once Task 3's templates put a
 * reset/verification URL in that body, either field can carry it straight
 * back. `error_code` (email-log.model.ts) is `varchar(32)` with a database
 * CHECK (`^[A-Z][A-Z0-9_]*$`) specifically so a wrong-shaped value can never
 * reach that column even if this function mis-extracted one — but this
 * function does not lean on that backstop; extracting the narrow, known-safe
 * field is what actually keeps a token or body fragment out of the log in
 * the first place.
 * @param error - Whatever the transport call rejected with.
 * @returns The extracted code, or `UNKNOWN_ERROR_CODE`.
 */
function extractErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return UNKNOWN_ERROR_CODE
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : UNKNOWN_ERROR_CODE
}

/**
 * The safe-to-log subset of a rejected send's error, for the operator's own
 * console/log stream.
 *
 * The email_logs table (email-log.model.ts) has a column-width-and-shape
 * guarantee against a leaked token or body reaching `error_code`; the
 * operator's log stream has no such structural backstop, so this function is
 * what keeps the identical property true there. Deliberately excludes
 * `.message` and `.response` for the same reason `extractErrorCode` does —
 * see its own comment.
 * @param error - Whatever the transport call rejected with.
 * @returns A redacted record when `error` is object-shaped; `error` itself otherwise (nothing to redact from a primitive).
 */
function redactedMailErrorForLog(error: unknown): unknown {
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
  }
}

/**
 * Record one delivery attempt, never letting a failure to record escape —
 * see this file's header comment (Ruling E) for why this is its own,
 * independent try/catch rather than sharing one with the send itself.
 * @param entry - The row to insert.
 */
async function recordDelivery(entry: NewEmailLog): Promise<void> {
  try {
    await emailLogRepository.record(entry)
  } catch (error) {
    console.error('Failed to record email delivery log', error)
  }
}

/**
 * Send one email and record the outcome in the delivery log. Never rejects
 * — see this file's header comment (Ruling G) for why that is load-bearing,
 * not merely convenient.
 * @param message - The email to send.
 * @returns Resolves once the send has been attempted and the outcome recorded, regardless of whether either step actually succeeded.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  let entry: NewEmailLog
  try {
    // Cast, not inference: nodemailer's own generic `Transporter<T, D>`
    // chain resolves `sendMail(...)`'s return type to `any` in this
    // installed @types/nodemailer version — verified empirically (assigning
    // the un-cast result to a `string`-typed variable produced no type
    // error, which only happens for `any`). `SMTPTransport.SentMessageInfo`
    // is the concrete, documented shape a real SMTP transport resolves
    // with (`messageId`, `envelope`, `accepted`, `rejected`, `pending`,
    // `response`); this cast states that real shape explicitly rather than
    // silently propagating `any` (and the unsafe-assignment/member-access it
    // would trip) through the rest of this function.
    const info = (await getMailTransporter().sendMail({
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })) as SMTPTransport.SentMessageInfo
    entry = {
      recipient: message.to,
      templateKey: message.templateKey,
      status: 'sent',
      providerMessageId: info.messageId,
    }
  } catch (error) {
    console.error('Mail send failed', redactedMailErrorForLog(error))
    entry = {
      recipient: message.to,
      templateKey: message.templateKey,
      status: 'failed',
      errorCode: extractErrorCode(error),
    }
  }
  await recordDelivery(entry)
}
