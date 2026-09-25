// tests/integration/services/mailer.service.test.ts
//
// Integration test: touches the real per-worker Postgres database (through
// EmailLogRepository) and the real Mailpit container (SMTP on 1025, its own
// HTTP API on 8025) — never mocked. See CLAUDE.md on why a test like this
// must live under tests/integration/, never tests/unit/.
//
// "Resolves identically for a recipient regardless of transport failure"
// is asserted here, at the service boundary: no request handler calls
// `sendMail` directly; mail reaches it through the queue (email.worker.ts).
//
// Task 3, fix round 1: `sendMail` now RENDERS internally (`MailMessage` is
// `{ to, templateKey, variables }`, not pre-rendered subject/text/html) —
// see mailer.service.ts's own header comment for the full reasoning. This
// file's tests were rewritten to match: every call site below supplies
// `variables` for a real template instead of literal `subject`/`text`
// strings, and several tests below are new, proving the two properties that
// change closes.
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMailTransporter } from '@/configs/mailer.config'
import {
  emailLogModel,
  UNKNOWN_ERROR_CODE,
  type EmailLog,
  type NewEmailLog,
} from '@/database/models/email-log.model'
import { HttpError } from '@/errors/http-error'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { db, sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { sendMail, type MailMessage } from '@/services/mailer.service'
import { renderEmailVerificationTemplate } from '@/templates/email/email-verification.template'
import { renderPasswordResetTemplate } from '@/templates/email/password-reset.template'
import { renderRegistrationAttemptTemplate } from '@/templates/email/registration-attempt.template'
import {
  assertNoMailpitMessage,
  deleteMailpitMessage,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'

const emailLogRepository = new EmailLogRepository()

/**
 * A disposable recipient address, unique to one test.
 * @param label - A short, human-readable tag for the test that owns it — makes a stray row easy to trace back.
 * @returns An email guaranteed unique to this call.
 */
function uniqueRecipient(label: string): string {
  return `mailer-service-${label}-${randomUUID()}@example.test`
}

/**
 * A real, valid `PasswordResetVariables` object — the standard input most
 * tests below use when they need SOME valid password_reset message and
 * don't care about its exact content.
 * @returns A fresh variables object (a fresh `resetUrl` per call, so two
 * calls in the same test never share a token-shaped value by accident).
 */
function validPasswordResetVariables(): { firstName: string; resetUrl: string; appName: string } {
  return {
    firstName: 'Ada',
    resetUrl: `https://example.test/reset?token=${randomUUID()}`,
    appName: 'Test App',
  }
}

// Nodemailer's own `sendMail` (node_modules/nodemailer/dist/cjs/mailer/index.d.ts
// — nodemailer 10 ships first-party types; nothing here resolves against
// @types/nodemailer, which this task does not depend on) is a two-way
// overload: `sendMail(data): Promise<T>` and `sendMail(data, callback):
// void`. A plain stub implementing only the promise form is not
// structurally assignable to that whole overloaded type, so
// `withMutatedMethod`'s `implementation` parameter needs the cast below.
// This is a type-system limitation of stubbing an overloaded third-party
// method, not a loosening of what the stub actually does at runtime — every
// test below drives it strictly through the `sendMail(mailOptions):
// Promise<T>` overload, the only one this codebase ever calls
// (mailer.config.ts's `getMailTransporter`/mailer.service.ts's `sendMail`).
type StubbedSendMail = (mailOptions: unknown) => Promise<{
  messageId: string
  envelope: unknown
  accepted: unknown[]
  rejected: unknown[]
  pending: unknown[]
  response: string
}>

// Module-scope, not inline in each test (unicorn/consistent-function-
// scoping): none of these capture anything test-local, unlike
// rejectWithLeakyMessage below, which genuinely closes over a
// per-test-generated token/body and stays where it is used.
const rejectWithConnectionError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Connection refused'), { code: 'ECONNECTION' })
  return Promise.reject(error)
}

const resolveWithFakeInfo: StubbedSendMail = () =>
  Promise.resolve({
    messageId: 'fake-message-id',
    envelope: {},
    accepted: [],
    rejected: [],
    pending: [],
    response: '',
  })

const rejectWithAuthError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Invalid login'), { code: 'EAUTH' })
  return Promise.reject(error)
}

// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error rejection, to prove extractErrorCode never assumes an object shape
const rejectWithAString: StubbedSendMail = () => Promise.reject('smtp exploded')

/**
 * `record()` with every Task 3 width-normalization guard removed — a plain
 * insert of whatever `entry` already is, unnormalized. Exists ONLY so the
 * "redacts a real failed delivery-log write" test below can still reach a
 * genuine Postgres 22001 through `sendMail`, now that `record()` itself
 * normalizes an over-width `templateKey`/`recipient`/`providerMessageId`
 * before any insert is attempted (email-log.repository.ts). Mirrors
 * email-log-error-code-shape-mutation.test.ts's `recordWithLengthOnlyGuard`
 * — same technique, same reason: keep the error real, bypass only the guard
 * that would otherwise intercept it first.
 * @param entry - The row to insert, exactly as given.
 * @returns The inserted row.
 */
async function recordWithoutNormalization(entry: NewEmailLog): Promise<EmailLog> {
  const [row] = await db.insert(emailLogModel).values(entry).returning()
  if (row === undefined) throw new HttpError('Insert returned no row', 500)
  return row
}

describe('sendMail', () => {
  const createdLogIds: string[] = []

  afterEach(async () => {
    if (createdLogIds.length === 0) return
    await sql`delete from email_logs where id = any(${createdLogIds})`
    createdLogIds.length = 0
  })

  // Step 3's required proof: a real send reaches Mailpit and is retrievable
  // through its own HTTP API — not a mock. Also the only place in this
  // task's tests where the SUCCESS branch runs against a real provider end
  // to end, so it also covers "records the outcome" for that branch: a
  // 'sent' row with a real providerMessageId, and no body text on it.
  //
  // The Subject assertion is the load-bearing one for this fix round:
  // computed independently, by calling `renderPasswordResetTemplate`
  // directly with the SAME variables, rather than a literal string — this
  // is what proves the Subject Mailpit actually received is the template's
  // own output, not something `sendMail`'s caller supplied.
  it('sends a real, template-rendered message that Mailpit receives, and records it as sent', async () => {
    const recipient = uniqueRecipient('real-send')
    const variables = validPasswordResetVariables()
    const expectedSubject = renderPasswordResetTemplate(variables).subject

    await sendMail({ to: recipient, templateKey: 'password_reset', variables })

    const messages = await findMailpitMessages(recipient)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toBe(expectedSubject)
    expect(messages[0]?.To[0]?.Address).toBe(recipient)
    if (messages[0]) await deleteMailpitMessage(messages[0].ID)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('sent')
    expect(rows[0]?.templateKey).toBe('password_reset')
    expect(rows[0]?.providerMessageId).toBeTruthy()
    expect(rows[0]?.errorCode).toBeNull()
    // The delivery log records THAT it sent, never WHAT — no rendered
    // content (not even the reset URL) reaches this table (see
    // email-log.model.ts's header comment for which columns this schema
    // actually guards).
    expect(JSON.stringify(rows[0])).not.toContain(variables.resetUrl)
  })

  // renderForMessage's switch (mailer.service.ts) has one case per real
  // template; the tests above and below all exercise it via
  // 'password_reset' for convenience, which never touches the other two
  // cases at all — an untested branch this codebase's own ethos treats as
  // a defect (mailer.service.ts's own comment on callFramesOf). This drives
  // all three templateKeys through the real `sendMail`, one call per
  // template (not a loop over a mixed-shape array, which would need an
  // `any` to pair each templateKey with its own variables type — the
  // discriminated union itself already proves that pairing at compile time,
  // in tests/unit/services/mailer.service.test.ts), and doubles as further
  // proof that a given templateKey's logged value and its
  // actually-delivered Subject always agree with each other and differ
  // across templates.
  //
  // Sequential, not concurrent, and with an explicit longer timeout: three
  // simultaneous real sends through the one shared transporter
  // (mailer.config.ts's `getMailTransporter` — one per process) measurably
  // failed against the real Mailpit container when tried concurrently here
  // ("command: 'CONN'" connection failures) — verified empirically, not
  // assumed. Three real SMTP round trips plus three Mailpit search polls run
  // one after another comfortably exceed this suite's default 20s per-test
  // budget (vitest.config.ts), hence the explicit override below.
  it('dispatches every templateKey to its own template — sent Subject and logged templateKey always agree', async () => {
    const verificationRecipient = uniqueRecipient('dispatch-email-verification')
    const verificationVariables = {
      firstName: 'Grace',
      verificationUrl: `https://example.test/verify?token=${randomUUID()}`,
      appName: 'Test App',
    }
    await sendMail({
      to: verificationRecipient,
      templateKey: 'email_verification',
      variables: verificationVariables,
    })
    const verificationMessages = await findMailpitMessages(verificationRecipient)
    expect(verificationMessages).toHaveLength(1)
    const expectedVerificationSubject =
      renderEmailVerificationTemplate(verificationVariables).subject
    expect(verificationMessages[0]?.Subject).toBe(expectedVerificationSubject)
    if (verificationMessages[0]) await deleteMailpitMessage(verificationMessages[0].ID)
    const verificationRows = await emailLogRepository.findByRecipient(verificationRecipient)
    createdLogIds.push(...verificationRows.map((row) => row.id))
    expect(verificationRows[0]?.status).toBe('sent')
    expect(verificationRows[0]?.templateKey).toBe('email_verification')

    const resetRecipient = uniqueRecipient('dispatch-password-reset')
    const resetVariables = validPasswordResetVariables()
    await sendMail({ to: resetRecipient, templateKey: 'password_reset', variables: resetVariables })
    const resetMessages = await findMailpitMessages(resetRecipient)
    expect(resetMessages).toHaveLength(1)
    const expectedResetSubject = renderPasswordResetTemplate(resetVariables).subject
    expect(resetMessages[0]?.Subject).toBe(expectedResetSubject)
    if (resetMessages[0]) await deleteMailpitMessage(resetMessages[0].ID)
    const resetRows = await emailLogRepository.findByRecipient(resetRecipient)
    createdLogIds.push(...resetRows.map((row) => row.id))
    expect(resetRows[0]?.status).toBe('sent')
    expect(resetRows[0]?.templateKey).toBe('password_reset')

    const attemptRecipient = uniqueRecipient('dispatch-registration-attempt')
    const attemptVariables = { firstName: 'Alan', appName: 'Test App' }
    await sendMail({
      to: attemptRecipient,
      templateKey: 'registration_attempt',
      variables: attemptVariables,
    })
    const attemptMessages = await findMailpitMessages(attemptRecipient)
    expect(attemptMessages).toHaveLength(1)
    const expectedAttemptSubject = renderRegistrationAttemptTemplate(attemptVariables).subject
    expect(attemptMessages[0]?.Subject).toBe(expectedAttemptSubject)
    if (attemptMessages[0]) await deleteMailpitMessage(attemptMessages[0].ID)
    const attemptRows = await emailLogRepository.findByRecipient(attemptRecipient)
    createdLogIds.push(...attemptRows.map((row) => row.id))
    expect(attemptRows[0]?.status).toBe('sent')
    expect(attemptRows[0]?.templateKey).toBe('registration_attempt')

    // The three templates' subjects are genuinely distinct — this is what
    // rules out "every branch happens to render the same thing" silently
    // passing this test.
    expect(
      new Set([expectedVerificationSubject, expectedResetSubject, expectedAttemptSubject]).size
    ).toBe(3)
  }, 40_000)

  // The gate task-2-brief.md's controller addendum requires. See this
  // file's own header comment for why it is asserted at the service
  // boundary rather than over HTTP.
  it('resolves identically for a recipient regardless of transport failure — the property Task 6 asserts end to end over HTTP', async () => {
    const transporter = getMailTransporter()
    const existingLikeRecipient = uniqueRecipient('existing')
    const unknownLikeRecipient = uniqueRecipient('unknown')

    await withMutatedMethod(
      transporter,
      'sendMail',
      rejectWithConnectionError as (typeof transporter)['sendMail'],
      async () => {
        const [existingOutcome, unknownOutcome] = await Promise.allSettled([
          sendMail({
            to: existingLikeRecipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          }),
          sendMail({
            to: unknownLikeRecipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          }),
        ])

        // This is the assertion that actually does the work: both calls
        // FULFIL despite the transport rejecting every time. A sendMail that
        // let the rejection propagate would make BOTH promises reject with
        // the identical error too — toStrictEqual below cannot by itself
        // distinguish "both fulfilled" from "both rejected the same way".
        expect(existingOutcome.status).toBe('fulfilled')
        expect(unknownOutcome.status).toBe('fulfilled')
        // The Task-6-shaped mirror: whatever the settlement is, it is
        // IDENTICAL regardless of which recipient it was for — direct
        // equality, not "both happen to be OK".
        expect(existingOutcome).toStrictEqual(unknownOutcome)
      }
    )

    const existingRows = await emailLogRepository.findByRecipient(existingLikeRecipient)
    const unknownRows = await emailLogRepository.findByRecipient(unknownLikeRecipient)
    createdLogIds.push(...existingRows.map((row) => row.id), ...unknownRows.map((row) => row.id))
    expect(existingRows[0]?.status).toBe('failed')
    expect(existingRows[0]?.errorCode).toBe('ECONNECTION')
    expect(unknownRows[0]?.status).toBe('failed')
    expect(unknownRows[0]?.errorCode).toBe('ECONNECTION')
  })

  // Fix round 1 on Task 3 (task-3-report.md's own forward flag, confirmed
  // and fixed by the coordinator): rendering used to run OUTSIDE sendMail,
  // so a missing-variable failure threw before Ruling G's catch ever ran —
  // a THIRD channel able to defeat the identical guarantee the test above
  // proves for transport failure. This is the direct mirror of that test,
  // for a rendering failure instead of a transport one.
  //
  // Driven through withMutatedModule (tests/helpers/mutate.ts), not by
  // constructing deliberately-malformed `variables` — both calls below use
  // entirely valid, well-typed messages; the failure is injected at the
  // template's own render function, exactly the way the transport-failure
  // test above injects failure at the transporter's own `sendMail` method,
  // never by hand-editing anything under src/.
  it('resolves identically for a recipient regardless of a rendering failure — the same property proven above for transport failure', async () => {
    const existingLikeRecipient = uniqueRecipient('render-fail-existing')
    const unknownLikeRecipient = uniqueRecipient('render-fail-unknown')

    await withMutatedModule(
      '@/templates/email/password-reset.template',
      {
        renderPasswordResetTemplate: () => {
          throw new Error('a variable present on only one enumeration branch was missing')
        },
      },
      () => import('@/services/mailer.service'),
      async (mailerServiceModule) => {
        const [existingOutcome, unknownOutcome] = await Promise.allSettled([
          mailerServiceModule.sendMail({
            to: existingLikeRecipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          }),
          mailerServiceModule.sendMail({
            to: unknownLikeRecipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          }),
        ])

        // Same shape of assertion as the transport-failure test above: both
        // FULFIL (a propagated rendering exception would make both REJECT
        // identically instead, which toStrictEqual alone cannot tell apart
        // from both fulfilling), and the settlement is identical regardless
        // of recipient.
        expect(existingOutcome.status).toBe('fulfilled')
        expect(unknownOutcome.status).toBe('fulfilled')
        expect(existingOutcome).toStrictEqual(unknownOutcome)
      }
    )

    const existingRows = await emailLogRepository.findByRecipient(existingLikeRecipient)
    const unknownRows = await emailLogRepository.findByRecipient(unknownLikeRecipient)
    createdLogIds.push(...existingRows.map((row) => row.id), ...unknownRows.map((row) => row.id))
    expect(existingRows[0]?.status).toBe('failed')
    expect(existingRows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
    expect(unknownRows[0]?.status).toBe('failed')
    expect(unknownRows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)

    // Neither recipient received anything — a rendering failure sends
    // nothing under any label, matching Ruling G's existing guarantee for a
    // transport failure.
    await assertNoMailpitMessage(existingLikeRecipient)
    await assertNoMailpitMessage(unknownLikeRecipient)
  })

  // Fix round 1 on Task 3: the second hole the coordinator closed —
  // `templateKey` used to be a caller-supplied LABEL, independent of the
  // content actually sent, so a caller could pass `templateKey:
  // 'password_reset'` next to unrelated body text. `MailMessage` is now a
  // discriminated union (mailer.service.ts), so a real caller cannot
  // construct this mismatch at all — proven at compile time in
  // tests/unit/services/mailer.service.test.ts. This is the runtime
  // counterpart, for a caller that bypasses the type system entirely (`as
  // unknown as MailMessage`, the same escape hatch every other "what if a
  // caller ignores the types" test in this codebase uses): a templateKey
  // that matches no real template can still never cause a wrong body to be
  // sent under it — rendering fails loudly instead, and nothing is sent at
  // all.
  it('a templateKey that matches no real template fails loudly and sends nothing, rather than sending mismatched content', async () => {
    const recipient = uniqueRecipient('unknown-template-key')
    const bogusMessage = {
      to: recipient,
      templateKey: 'not_a_real_template',
      variables: { firstName: 'Ada' },
    } as unknown as MailMessage

    // No transport mutation needed: renderForMessage's default branch
    // throws synchronously, before the transport is ever reached — the
    // real transporter is never touched by this test.
    await expect(sendMail(bogusMessage)).resolves.toBe('failed')

    await assertNoMailpitMessage(recipient)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('failed')
    // The DECLARED key survives into the log, honestly — "this is what was
    // attempted and it failed", not silently substituted or dropped.
    expect(rows[0]?.templateKey).toBe('not_a_real_template')
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })

  // Task 3's original escaping proof (tests/unit/templates/email/*.test.ts)
  // exercises each template's render function directly. This is the same
  // property through the new boundary: a dangerous value in `variables`,
  // driven all the way through the real `sendMail` -> real transport -> real
  // Mailpit delivery, confirming the HTML Mailpit actually stored is
  // escaped — not merely what a template function returns in isolation.
  it('escapes a dangerous variable in the real HTML Mailpit receives, through sendMail end to end', async () => {
    const recipient = uniqueRecipient('escaping-through-sendmail')
    const payload = '<img src=x onerror=alert(1)>'

    await sendMail({
      to: recipient,
      templateKey: 'password_reset',
      variables: { ...validPasswordResetVariables(), firstName: payload },
    })

    const messages = await findMailpitMessages(recipient)
    expect(messages).toHaveLength(1)
    const messageId = messages[0]?.ID
    expect(messageId).toBeDefined()

    const detail = await getMailpitMessage(messageId ?? '')
    await deleteMailpitMessage(messageId ?? '')

    expect(detail.HTML).not.toContain(payload)
    expect(detail.HTML).not.toContain('<img')
    expect(detail.HTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // The plain-text part is not HTML — it must carry the raw value.
    expect(detail.Text).toContain(payload)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
  })

  // Ruling E (task-4-brief.md, repeated in task-2-brief.md's addendum): a
  // failed delivery-log write must not fail the send either — by the time
  // the row is attempted the mail has already gone out.
  it('still resolves when recording the delivery log fails', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('log-write-fails')

    await withMutatedMethod(
      transporter,
      'sendMail',
      resolveWithFakeInfo as (typeof transporter)['sendMail'],
      async () => {
        await withMutatedMethod(
          EmailLogRepository.prototype,
          'record',
          () => Promise.reject(new Error('database unreachable')),
          async () => {
            // The transport call itself succeeds (resolveWithFakeInfo,
            // mutated above); only the delivery-log write fails, and Ruling
            // E keeps that failure from affecting what sendMail reports —
            // so this still resolves 'sent'.
            await expect(
              sendMail({
                to: recipient,
                templateKey: 'password_reset',
                variables: validPasswordResetVariables(),
              })
            ).resolves.toBe('sent')
          }
        )
      }
    )
    // No row to clean up: the (mutated) write never landed one — confirmed
    // by construction, not re-asserted here.
  })

  // Fix round 1 (coordinator review): recordDelivery used to log the RAW
  // error from a failed record() call — a Drizzle query error whose bound
  // parameters include entry.recipient, an email address (PII). This proves
  // the fix against a REAL failing insert, not a synthetic error shape.
  //
  // Task 3 (task-3-brief.md's Controller addendum, item 2) added width
  // normalization for recipient/templateKey/providerMessageId
  // (email-log.repository.ts), so none of `record()`'s own guarded fields
  // can reach the database over-width through the SUCCESS path any more —
  // and Task 3's fix round 1 (this file's header comment) means an
  // over-width `templateKey` in particular is now UNREACHABLE on the
  // success path at all: `entry.templateKey` on success is always
  // `rendered.templateKey`, one of the three short, template-owned
  // constants, never anything caller-supplied. The vehicle for a genuine
  // 22001 through `sendMail` is therefore `recipient` now, not
  // `templateKey` — still fully type-safe (an over-length `to` needs no
  // cast at all) — with `record()`'s own normalization guard bypassed via
  // `recordWithoutNormalization`, the same "keep the error real, bypass the
  // guard" technique as
  // tests/integration/repositories/email-log-error-code-shape-mutation.test.ts's
  // `recordWithLengthOnlyGuard`.
  it('redacts a real failed delivery-log write, dropping the recipient PII it would otherwise log', async () => {
    const transporter = getMailTransporter()
    // > MAX_EMAIL_LENGTH (320): email-log.model.ts's recipient width.
    const overWidthRecipient = `${'a'.repeat(400)}@example.test`

    // vi.spyOn on logger.error, not a plain reassignment: the original
    // console-interception unreliability this comment used to describe was
    // specific to the `console` global — some layer of the test/runtime
    // stack appeared to reset a vi.spyOn wrapper against it mid-test, under
    // a condition never fully tracked down. `logger` is a plain
    // module-scope object exported from logger.service.ts, not a global
    // anything intercepts or rewraps, so vi.spyOn against it is reliable.
    // `.mockRestore()` in a `finally`, not a bare afterEach: this project's
    // vitest config sets neither restoreMocks nor mockReset
    // (tests/helpers/mutate.ts's header comment gives the identical reason
    // for withMutatedMethod/withMutatedModule's own restore-in-finally
    // shape), so nothing else undoes this spy if the test doesn't.
    const capturedErrorCalls: [string, Record<string, unknown> | undefined][] = []
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation((message, meta) => {
      capturedErrorCalls.push([message, meta])
    })
    try {
      await withMutatedMethod(
        EmailLogRepository.prototype,
        'record',
        recordWithoutNormalization,
        async () => {
          await withMutatedMethod(
            transporter,
            'sendMail',
            resolveWithFakeInfo as (typeof transporter)['sendMail'],
            async () => {
              // Same reasoning as the sibling "still resolves when
              // recording the delivery log fails" test above: the transport
              // call succeeds, only the (unnormalized) insert fails, so
              // this resolves 'sent'.
              await expect(
                sendMail({
                  to: overWidthRecipient,
                  templateKey: 'password_reset',
                  variables: validPasswordResetVariables(),
                })
              ).resolves.toBe('sent')
            }
          )
        }
      )

      const recordFailureCall = capturedErrorCalls.find(
        (call) => call[0] === 'Failed to record email delivery log'
      )
      expect(recordFailureCall).toBeDefined()
      const logged = recordFailureCall?.[1] as { error?: { driverCode?: unknown } } | undefined
      // The real property: the recipient address never appears anywhere in
      // what was logged, whether as a top-level field or buried inside a
      // bound parameter value.
      expect(JSON.stringify(logged)).not.toContain(overWidthRecipient)
      // Not simply omitted by accident — the driver's own SQLSTATE code
      // (22001, string data right truncation) survives, which is what makes
      // the log line still worth having at all.
      expect(logged?.error?.driverCode).toBeDefined()
    } finally {
      loggerErrorSpy.mockRestore()
    }

    // No row to clean up: the insert genuinely failed and nothing landed.

    // The send itself succeeded (resolveWithFakeInfo) and Mailpit is never
    // touched by that stub — no message to clean up there either.
  })

  // CARRY-FORWARD from progress.md's Task-2 dispatch note: Task 4's own
  // leak proof only covers the SUCCESS path (a caller passing a raw
  // errorCode directly to record()). This is the failure-path half: a
  // transport rejection whose OWN message embeds both a raw token and the
  // rendered body — the realistic shape of a real SMTP rejection, which
  // routinely echoes content back from the server — must still never reach
  // the table. extractErrorCode (mailer.service.ts) reads ONLY `.code`.
  it('never lets an error message or the message body reach the delivery log or the log stream', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('leak-proof')
    const rawToken = randomBytes(32).toString('hex')
    const resetUrl = `https://example.test/reset?token=${rawToken}`
    const leakyMessage = `550 rejected: message body contained "Reset your password: ${resetUrl}"`

    const rejectWithLeakyMessage: StubbedSendMail = () => Promise.reject(new Error(leakyMessage))

    // Fix round 2 (task-2-review.md, finding 1): this test used to check
    // ONLY the email_logs row. `recordDelivery`'s redaction (Ruling E) had
    // its own dedicated test after fix round 1; `sendMail`'s SEND-path
    // catch — the one that actually receives the SMTP server's echoed
    // reply — had none. Reverting `redactedMailErrorForLog(error)` to plain
    // `error` in that catch made every test in this file still pass before
    // this addition. vi.spyOn(logger, 'error'), not a plain reassignment —
    // same reasoning as the sibling test above in this file.
    const capturedErrorCalls: [string, Record<string, unknown> | undefined][] = []
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation((message, meta) => {
      capturedErrorCalls.push([message, meta])
    })
    try {
      await withMutatedMethod(
        transporter,
        'sendMail',
        rejectWithLeakyMessage as (typeof transporter)['sendMail'],
        async () => {
          await expect(
            sendMail({
              to: recipient,
              templateKey: 'password_reset',
              variables: { firstName: 'Ada', resetUrl, appName: 'Test App' },
            })
          ).resolves.toBe('failed')
        }
      )

      // Read the table directly — not record()'s return value, not
      // findByRecipient — a proof that only reads back its own argument
      // proves nothing about what actually landed on disk (the same
      // reasoning task-4-report.md gives for the identical proof one layer
      // down).
      const [row] = await sql`select * from email_logs where recipient = ${recipient}`
      if (row) createdLogIds.push(row.id as string)

      expect(row).toBeDefined()
      // Positive claim (Ruling O, this task's dispatch): the recipient IS the
      // address actually mailed, not derived from the error in any way.
      expect(row?.recipient).toBe(recipient)
      expect(row?.error_code).toBe(UNKNOWN_ERROR_CODE)
      const serializedRow = JSON.stringify(row)
      expect(serializedRow).not.toContain(rawToken)
      expect(serializedRow).not.toContain(resetUrl)
      expect(serializedRow).not.toContain('550 rejected')

      // The log-stream half: what actually reached logger.error for the
      // SEND failure (distinct from recordDelivery's own 'Failed to record
      // email delivery log' line, which this test never triggers — the log
      // write itself succeeds).
      //
      // util.inspect, NOT JSON.stringify, on the captured payload — verified
      // empirically that this distinction is load-bearing, not stylistic:
      // `JSON.stringify(new Error('...'))` is `"{}"`, because Error's own
      // `message`/`stack` are NON-ENUMERABLE own properties, which
      // JSON.stringify skips. A plain `JSON.stringify(sendFailureCall?.[1])`
      // check here would have reported "clean" whether or not the code
      // redacted anything — the exact "gate that reports success while
      // enforcing nothing" pattern this fix round exists to close, and it
      // would have shipped inside the test meant to prove the fix.
      // util.inspect is what Node's own console formatting actually uses for
      // a non-string argument, so it reveals an Error's message the way a
      // real operator's terminal or log aggregator would.
      const sendFailureCall = capturedErrorCalls.find((call) => call[0] === 'Mail send failed')
      expect(sendFailureCall).toBeDefined()
      // eslint-disable-next-line unicorn/no-null -- node:util's own inspect() API requires literal null for "unlimited depth"
      const inspectedLogged = inspect(sendFailureCall?.[1], { depth: null })
      expect(inspectedLogged).not.toContain(rawToken)
      expect(inspectedLogged).not.toContain(resetUrl)
      expect(inspectedLogged).not.toContain('550 rejected')
    } finally {
      loggerErrorSpy.mockRestore()
    }
  })

  it('carries a real nodemailer error code through to the log unchanged', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('real-code')

    await withMutatedMethod(
      transporter,
      'sendMail',
      rejectWithAuthError as (typeof transporter)['sendMail'],
      async () => {
        await sendMail({
          to: recipient,
          templateKey: 'password_reset',
          variables: validPasswordResetVariables(),
        })
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.errorCode).toBe('EAUTH')
  })

  it('extracts UNKNOWN_ERROR_CODE from a non-object rejection without throwing', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('non-object-rejection')

    await withMutatedMethod(
      transporter,
      'sendMail',
      rejectWithAString as (typeof transporter)['sendMail'],
      async () => {
        await expect(
          sendMail({
            to: recipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          })
        ).resolves.toBe('failed')
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })

  // Fix round 2 (task-2-review.md, finding 6): `getMailTransporter()`
  // sitting INSIDE sendMail's try (mailer.service.ts) is correct by
  // construction today, but nothing PINS it there — hoisting it to
  // `const transporter = getMailTransporter()` above the try is a natural,
  // innocent-looking refactor that would silently reopen Ruling G on the
  // transport-CREATION path, and every other test in this file would stay
  // green (they all mutate an already-created transporter's own `sendMail`
  // method, never the creation step itself). `withMutatedMethod` cannot
  // reach this — there is no already-constructed transporter to mutate
  // before one exists — so this uses `withMutatedModule` instead, mocking
  // `getMailTransporter` itself as a dependency of a freshly reloaded
  // `mailer.service` module. This is the intended shape for that helper
  // (mailer.config.ts's `getMailTransporter` is imported BY VALUE, not a
  // shared prototype method), and it is a genuinely committable proof, not
  // an uncommitted TDD red run — unlike the Ruling G gate itself, which
  // has no dependency edge to intercept at all.
  it('does not reject even when creating the transporter itself throws', async () => {
    const recipient = uniqueRecipient('transport-creation-fails')

    await withMutatedModule(
      '@/configs/mailer.config',
      {
        getMailTransporter: () => {
          throw new Error('boom: transport creation failed')
        },
      },
      () => import('@/services/mailer.service'),
      async (mailerServiceModule) => {
        await expect(
          mailerServiceModule.sendMail({
            to: recipient,
            templateKey: 'password_reset',
            variables: validPasswordResetVariables(),
          })
        ).resolves.toBe('failed')
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })
})
