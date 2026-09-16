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
// RENDERING HAPPENS INSIDE THE SAME TRY THAT GUARDS THE TRANSPORT CALL —
// this is a Task 3 fix-round correction, not the original design. Templates
// used to render OUTSIDE this function (a caller passed already-rendered
// subject/text/html in), which left rendering exceptions outside Ruling G's
// catch entirely — three independent channels ended up able to defeat the
// same ruling: the STATUS channel (closed by Ruling G itself), the LATENCY
// channel (bounded by Task 2's SMTP_*_TIMEOUT settings), and this one, the
// EXCEPTION channel — a variable present only on one branch of an
// enumeration-sensitive caller (say, a name that exists only for a
// registered user) would throw during rendering, before any catch ever ran,
// turning "does this address have an account?" back into a 500-vs-200
// question. Rendering now happens where the transport call does, inside the
// identical try/catch, so a `requireEmailVariables` throw (a plain `Error`,
// no `.code`) is handled EXACTLY like a transport rejection: caught,
// recorded as a 'failed' delivery with `errorCode: UNKNOWN_ERROR_CODE`, and
// never propagated. See tests/integration/services/mailer.service.test.ts
// for the direct-equality proof this holds across both branches of an
// enumeration-sensitive call, mirroring the transport-failure proof already
// there.
//
// `MailMessage` NO LONGER CARRIES subject/text/html — a second, independent
// fix in the same round. The old shape let a caller pass `templateKey:
// 'password_reset'` alongside body text that was actually something else
// entirely; nothing tied the logged key to the content that was actually
// sent, which makes `email_logs` unable to answer the one question an audit
// table exists for ("what did this row actually record?"). `MailMessage` is
// now a discriminated union keyed on `templateKey`, where `variables` is
// typed to match ONLY that key's own template — subject/text/html are
// produced by `renderForMessage` below, from that key and those variables,
// and nothing else. This closes a THIRD thing as a side effect, worth
// stating deliberately rather than leaving implicit: "no token may appear
// in a subject line" (task-3-brief.md) used to be a convention a caller
// could violate by constructing its own subject string. It is now
// structural for the message FIELDS: there is no caller-suppliable
// `subject`/`text`/`html` left to put a token into. It is NOT yet total, and
// the gap is worth naming rather than glossing: `variables.appName` is typed
// plain `string` and is interpolated into one template's subject
// (registration-attempt.template.ts), so a caller that put content there would
// still reach a Subject header. Closing that properly means sourcing `appName`
// from config instead of accepting it per-message — see the plan's "Execution
// status" section. Re-exposing a caller-suppliable `subject` (or `text`/
// `html`) on this interface would silently reopen both of these; don't, no
// matter how convenient it looks for a one-off caller.
//
// TWO INDEPENDENT catches, not one wrapping both halves, on purpose:
//
//   1. Rendering AND the transport call (getMailTransporter().sendMail(...))
//      are the only things the first try/catch guards. Its catch never
//      re-throws — it just decides which `NewEmailLog` to build.
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
import { logger } from '@/services/logger.service'
import {
  EMAIL_VERIFICATION_TEMPLATE_KEY,
  renderEmailVerificationTemplate,
  type EmailVerificationVariables,
} from '@/templates/email/email-verification.template'
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
import type { RenderedEmail } from '@/utilities/email-template.utilities'

const emailLogRepository = new EmailLogRepository()

/**
 * One outbound email, identified by which template renders it and that
 * template's own variables — never by pre-rendered content. A discriminated
 * union on `templateKey`, not a flat `{ templateKey: EmailTemplateKey;
 * variables: SomeVariables }` shape: the flat shape would let TypeScript
 * accept `templateKey: 'password_reset'` paired with
 * `RegistrationAttemptVariables`, which is exactly the key/content mismatch
 * this file's header comment explains closing. Each member below pins one
 * template's own exported key constant (typed via `satisfies`, not a
 * `: EmailTemplateKey` annotation, so it stays the narrow literal a
 * discriminated union needs — see each template's own comment on this) to
 * that template's own `*Variables` interface, so a caller cannot construct
 * one without the other agreeing.
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

/**
 * Render `message` against its own declared template — the ONLY place in
 * this module content is produced, and therefore the only place that
 * decides what `sendMail` below actually sends and logs.
 *
 * A `switch` on `message.templateKey`, not a lookup object indexed by it:
 * TypeScript narrows `message.variables` to the correct `*Variables`
 * interface inside each `case` because `MailMessage` is a discriminated
 * union on that exact field — a lookup-object call (`renderers[key](vars)`)
 * cannot express that narrowing, since indexing loses the connection
 * between the key just read and the value about to be passed.
 *
 * The `default` case below IS reachable, despite `MailMessage`'s three
 * named cases already covering every value the TYPE system allows: a
 * caller can still bypass that (`as unknown as MailMessage`), the same
 * boundary `email-log.repository.ts`'s `withTemplateKeyNormalized` and
 * `extractErrorCode`'s own object-shape check exist for — this codebase's
 * consistent position that a compile-time guarantee is not a runtime one
 * until something also checks it there. Throwing explicitly here, rather
 * than falling through to an implicit `undefined` return that would crash
 * later on `rendered.subject` with an unrelated TypeError, keeps this
 * failure INDISTINGUISHABLE from any other rendering failure to `sendMail`'s
 * own catch — the same Ruling G guarantee, deliberately, not by accident of
 * which property happened to be read first. See
 * tests/integration/services/mailer.service.test.ts's "a templateKey that
 * matches no real template..." test for the proof this branch is actually
 * exercised, not merely written for the type checker's sake.
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
    default: {
      // See this function's own JSDoc for why this branch is reachable at
      // all, and why it throws explicitly rather than falling through.
      // `message` is narrowed to `never` here (every named case above
      // already covers its type), so reading `.templateKey` off it is only
      // meaningful at runtime, against a value that bypassed `MailMessage`
      // entirely — the cast makes that explicit rather than fighting it.
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
    logger.error('Failed to record email delivery log', { error: redactedForLog(error) })
  }
}

/**
 * Render, send, and record the outcome of one email. Never rejects — see
 * this file's header comment (Ruling G) for why that is load-bearing, not
 * merely convenient, and now covers a RENDERING failure exactly the same
 * way it already covered a transport failure — see this file's header
 * comment for why that closes a real gap, not a theoretical one.
 *
 * `entry.templateKey` in the catch branch is `message.templateKey` — the
 * DECLARED key, read before rendering was attempted — never something
 * derived from partial rendering output, because there is none: a thrown
 * render either produces a `RenderedEmail` or nothing at all, so this is
 * the only value available either way. This still cannot disagree with
 * what was actually attempted: `message.templateKey` is exactly the value
 * `renderForMessage` switched on to decide which template to run, so the
 * logged key always names the template that was really invoked, whether it
 * succeeded or not.
 * @param message - The email to render and send.
 * @returns `'sent'` or `'failed'`, reflecting the recorded `email_logs` status — resolves once the send has been attempted and the outcome recorded, regardless of whether rendering, sending, or recording actually succeeded. Callers that need to decide whether to retry (e.g. `email.worker.ts`) read this; callers that don't (every caller before Task 2) can keep ignoring it.
 */
export async function sendMail(message: MailMessage): Promise<'sent' | 'failed'> {
  let entry: NewEmailLog
  try {
    // Rendering runs INSIDE this try — see this file's header comment for
    // why: a thrown `requireEmailVariables` error must be handled exactly
    // like a transport rejection, not escape uncaught.
    const rendered = renderForMessage(message)
    // `info` is inferred as `SMTPTransport.SentMessageInfo` directly, no
    // cast — `getMailTransporter`'s own return type annotation
    // (mailer.config.ts) names the exact overload of nodemailer's
    // `createTransport` this app uses.
    const info = await getMailTransporter().sendMail({
      to: message.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    })
    entry = {
      recipient: message.to,
      templateKey: rendered.templateKey,
      status: 'sent',
      providerMessageId: info.messageId,
    }
  } catch (error) {
    logger.error('Mail send failed', { error: redactedMailErrorForLog(error) })
    entry = {
      recipient: message.to,
      templateKey: message.templateKey,
      status: 'failed',
      errorCode: extractErrorCode(error),
    }
  }
  await recordDelivery(entry)
  return entry.status === 'sent' ? 'sent' : 'failed'
}
