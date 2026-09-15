// src/services/mailer.service.ts
//
// Ruling G (task-2-brief.md, "Controller addendum"): a mail-send failure
// must NEVER propagate to the caller. `sendMail` below is structured so
// that holds for every failure mode nodemailer itself produces — read this
// comment before touching the control flow. (Not an absolute "cannot ever
// reject" guarantee: both catch BODIES run unguarded code —
// `redactedMailErrorForLog`/`extractErrorCode` read a handful of properties
// off `error`, and `console.error` itself could theoretically throw — so a
// sufficiently poisoned getter or a broken output stream would still
// escape. Nodemailer constructs plain `Error`s with plain data properties,
// so that is not reachable through any error this transport actually
// produces; the claim is scoped to that, not to arbitrary JavaScript.)
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
import { getMailTransporter } from '@/configs/mailer.config'
import { UNKNOWN_ERROR_CODE, type NewEmailLog } from '@/database/models/email-log.model'
import { redactedForLog } from '@/middlewares/error.middleware'
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
export function extractErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return UNKNOWN_ERROR_CODE
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : UNKNOWN_ERROR_CODE
}

/**
 * The `at ...` call frames of an object-shaped error's stack, with its
 * message line removed — mirrors `stackFramesOf` in error.middleware.ts
 * exactly, for the identical reason: `error.stack` embeds the message
 * verbatim on its first line, and the message is precisely what
 * `redactedMailErrorForLog` below must not log. The frames themselves are
 * still worth keeping — for a genuine bug in THIS module (a TypeError, not
 * an SMTP rejection), `name`/`code`/`command`/`responseCode` alone would be
 * `{ name: 'TypeError' }` and nothing else, which is not enough to find
 * where a real defect actually threw.
 *
 * Takes `object`, not `unknown` — its one caller has already narrowed to
 * that (checking it again here would be a branch no real call site can ever
 * take the other side of, which is exactly the kind of untested,
 * unreachable condition this project treats as a defect in itself).
 *
 * Matches `/^\s+at /` — a real frame, NOT `line.trimStart().startsWith('at
 * ')`. V8 always indents a genuine call frame with at least four spaces;
 * requiring leading whitespace before `at ` is what makes an UNINDENTED
 * line that merely happens to begin with those two characters fail to
 * match. That matters specifically because the message this function
 * strips is server-controlled and multi-line: `trimStart()` before the
 * check would throw away the exact signal (indentation) that separates a
 * true stack frame from a message line, so a message crafted to start a
 * line with `at ` would have survived into the log.
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
 * The safe-to-log subset of a rejected send's error, for the operator's own
 * console/log stream.
 *
 * The email_logs table (email-log.model.ts) has a column-width-and-shape
 * guarantee against a leaked token or body reaching `error_code`; the
 * operator's log stream has no such structural backstop, so this function is
 * what keeps the identical property true there. Deliberately excludes
 * `.message` and `.response` for the same reason `extractErrorCode` does —
 * see its own comment — while `stack` (via `callFramesOf`, message line
 * stripped) is kept, so a genuine bug in this module's own code is still
 * diagnosable and not merely indistinguishable from a real SMTP rejection.
 *
 * Exported for direct unit testing — see tests/unit/services/mailer.service.test.ts
 * — for the same reason `mailTransportOptions` (mailer.config.ts) is: this
 * codebase does not tolerate a branch that only a real SMTP round trip
 * could reach.
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
 * Record one delivery attempt, never letting a failure to record escape —
 * see this file's header comment (Ruling E) for why this is its own,
 * independent try/catch rather than sharing one with the send itself.
 *
 * A failed `record()` is a Drizzle query error — the same shape
 * `error.middleware.ts` already redacts for every other failed write in
 * this codebase — so this reuses `redactedForLog` from there rather than
 * logging the raw error. That matters here specifically: the insert's bound
 * parameters include `entry.recipient`, an email address, and an
 * unredacted `console.error` would put it straight into the log stream —
 * PII, not a secret (no token reaches this path; `withErrorCodeNormalized`,
 * email-log.repository.ts, already guarantees that), but exactly the class
 * of leak B2's `fix: never log bound query parameters` built this
 * redaction to close everywhere else.
 * @param entry - The row to insert.
 */
async function recordDelivery(entry: NewEmailLog): Promise<void> {
  try {
    await emailLogRepository.record(entry)
  } catch (error) {
    console.error('Failed to record email delivery log', redactedForLog(error))
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
    // `info` is inferred as `SMTPTransport.SentMessageInfo` directly, no
    // cast — `getMailTransporter`'s own return type annotation
    // (mailer.config.ts) names the exact overload of nodemailer's
    // `createTransport` this app uses.
    const info = await getMailTransporter().sendMail({
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
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
