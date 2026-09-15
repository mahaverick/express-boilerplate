// tests/integration/services/mailer.service.test.ts
//
// Integration test: touches the real per-worker Postgres database (through
// EmailLogRepository) and the real Mailpit container (SMTP on 1025, its own
// HTTP API on 8025) — never mocked. See CLAUDE.md on why a test like this
// must live under tests/integration/, never tests/unit/.
//
// The gate this task's controller addendum requires (task-2-brief.md,
// "Controller addendum", "The test this ruling requires") lives here:
// "resolves identically for a recipient regardless of transport failure".
// `auth.controller.ts` does not call `sendMail` anywhere yet — there is no
// endpoint to wire it to at this point in the plan's execution order
// (Ruling C, progress.md: 0, 1, 4, 2, 3, 5, 6, 7, 8) — so this asserts the
// addendum's own named fallback: the equivalent property at the service
// boundary. The end-to-end, byte-identical-HTTP-response assertion belongs
// to Task 6.
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { getMailTransporter } from '@/configs/mailer.config'
import { UNKNOWN_ERROR_CODE } from '@/database/models/email-log.model'
import { EmailLogRepository } from '@/repositories/email-log.repository'
import { sql } from '@/services/database.service'
import { sendMail } from '@/services/mailer.service'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'

const emailLogRepository = new EmailLogRepository()
const MAILPIT_API = 'http://localhost:8025/api/v1'

interface MailpitMessage {
  ID: string
  To: { Address: string }[]
  Subject: string
}

/**
 * Poll Mailpit's own HTTP API for messages to one recipient, retrying
 * briefly — a real SMTP delivery is not synchronous with Mailpit's search
 * index becoming queryable.
 * @param recipient - The `To:` address to search for.
 * @returns Every matching message; empty if none arrived within the budget.
 */
async function findMailpitMessages(recipient: string): Promise<MailpitMessage[]> {
  const query = `to:${recipient}`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`)
    const body = (await response.json()) as { messages: MailpitMessage[] }
    if (body.messages.length > 0) return body.messages
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

/**
 * Delete one message from Mailpit by id. Best-effort tidiness only, for a
 * mailbox shared across the whole test run — never asserted on, and scoped
 * to one message id so it cannot touch another test's in-flight mail.
 * @param id - The Mailpit message id.
 */
async function deleteMailpitMessage(id: string): Promise<void> {
  try {
    await fetch(`${MAILPIT_API}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: [id] }),
    })
  } catch {
    // Best-effort only — see this function's own comment.
  }
}

/**
 * A disposable recipient address, unique to one test.
 * @param label - A short, human-readable tag for the test that owns it — makes a stray row easy to trace back.
 * @returns An email guaranteed unique to this call.
 */
function uniqueRecipient(label: string): string {
  return `mailer-service-${label}-${randomUUID()}@example.test`
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
  it('sends a real message that Mailpit receives, and records it as sent', async () => {
    const recipient = uniqueRecipient('real-send')
    const bodyText = 'This is the minimal body this task sends; templates are Task 3.'

    await sendMail({
      to: recipient,
      subject: 'Task 2 integration test',
      text: bodyText,
      templateKey: 'password_reset',
    })

    const messages = await findMailpitMessages(recipient)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toBe('Task 2 integration test')
    expect(messages[0]?.To[0]?.Address).toBe(recipient)
    if (messages[0]) await deleteMailpitMessage(messages[0].ID)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('sent')
    expect(rows[0]?.providerMessageId).toBeTruthy()
    expect(rows[0]?.errorCode).toBeNull()
    // The delivery log records THAT it sent, never WHAT — no body text
    // reaches this table (see email-log.model.ts's header comment for
    // which columns this schema actually guards).
    expect(JSON.stringify(rows[0])).not.toContain('minimal body')
  })

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
            subject: 'x',
            text: 'x',
            templateKey: 'password_reset',
          }),
          sendMail({
            to: unknownLikeRecipient,
            subject: 'x',
            text: 'x',
            templateKey: 'password_reset',
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
            await expect(
              sendMail({ to: recipient, subject: 'x', text: 'x', templateKey: 'password_reset' })
            ).resolves.toBeUndefined()
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
  // the fix against a REAL failing insert, not a synthetic error shape: an
  // over-width templateKey (> 32, email-log.model.ts's `template_key`
  // column width) makes the actual INSERT reject with a genuine
  // DrizzleQueryError wrapping a real postgres.PostgresError in `.cause` —
  // exactly the shape `error.middleware.ts`'s `redactedForLog` (now reused
  // by `recordDelivery`) was built to redact everywhere else in this
  // codebase.
  it('redacts a real failed delivery-log write, dropping the recipient PII it would otherwise log', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('recorded-write-fails-for-real')
    const overWidthTemplateKey = 'x'.repeat(64) // > 32: email-log.model.ts's template_key width

    // Plain property assignment, not vi.spyOn — mirrors tests/helpers/mutate.ts's
    // own stated reason for the identical choice (its header comment): no
    // mocking-framework state to reconcile with this project's vitest
    // config, which sets neither restoreMocks nor mockReset. Verified
    // empirically that this matters here, not just in mutate.ts: vi.spyOn(
    // console, 'error') reliably missed the call this specific test needs to
    // capture, while capturing an identical call in isolated repro files —
    // this project's own console-interception layer appears to reset a
    // vi.spyOn wrapper mid-test under some condition not tracked down
    // further; a plain reassignment has no such state to lose.
    const capturedErrorCalls: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...callArguments: unknown[]): void => {
      capturedErrorCalls.push(callArguments)
    }
    try {
      await withMutatedMethod(
        transporter,
        'sendMail',
        resolveWithFakeInfo as (typeof transporter)['sendMail'],
        async () => {
          await expect(
            sendMail({ to: recipient, subject: 'x', text: 'x', templateKey: overWidthTemplateKey })
          ).resolves.toBeUndefined()
        }
      )
    } finally {
      console.error = originalConsoleError
    }

    const recordFailureCall = capturedErrorCalls.find(
      (call) => call[0] === 'Failed to record email delivery log'
    )
    expect(recordFailureCall).toBeDefined()
    const logged = recordFailureCall?.[1] as { driverCode?: unknown } | undefined
    // The real property: the recipient address never appears anywhere in
    // what was logged, whether as a top-level field or buried inside a
    // bound parameter value.
    expect(JSON.stringify(logged)).not.toContain(recipient)
    // Not simply omitted by accident — the driver's own SQLSTATE code
    // (22001, string data right truncation) survives, which is what makes
    // the log line still worth having at all.
    expect(logged?.driverCode).toBeDefined()

    // No row to clean up: the insert genuinely failed and nothing landed.
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
    const bodyText = `Reset your password: https://example.test/reset?token=${rawToken}`
    const leakyMessage = `550 rejected: message body contained "${bodyText}"`

    const rejectWithLeakyMessage: StubbedSendMail = () => Promise.reject(new Error(leakyMessage))

    // Fix round 2 (task-2-review.md, finding 1): this test used to check
    // ONLY the email_logs row. `recordDelivery`'s redaction (Ruling E) had
    // its own dedicated test after fix round 1; `sendMail`'s SEND-path
    // catch — the one that actually receives the SMTP server's echoed
    // reply — had none. Reverting `redactedMailErrorForLog(error)` to plain
    // `error` in that catch made every test in this file still pass before
    // this addition. Plain console.error reassignment, not vi.spyOn — same
    // reasoning as the sibling test in this file.
    const capturedErrorCalls: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...callArguments: unknown[]): void => {
      capturedErrorCalls.push(callArguments)
    }
    try {
      await withMutatedMethod(
        transporter,
        'sendMail',
        rejectWithLeakyMessage as (typeof transporter)['sendMail'],
        async () => {
          await expect(
            sendMail({
              to: recipient,
              subject: 'irrelevant',
              text: bodyText,
              templateKey: 'password_reset',
            })
          ).resolves.toBeUndefined()
        }
      )
    } finally {
      console.error = originalConsoleError
    }

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
    expect(serializedRow).not.toContain(bodyText)
    expect(serializedRow).not.toContain('550 rejected')

    // The log-stream half: what actually reached console.error for the
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
    expect(inspectedLogged).not.toContain(bodyText)
    expect(inspectedLogged).not.toContain('550 rejected')
  })

  it('carries a real nodemailer error code through to the log unchanged', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('real-code')

    await withMutatedMethod(
      transporter,
      'sendMail',
      rejectWithAuthError as (typeof transporter)['sendMail'],
      async () => {
        await sendMail({ to: recipient, subject: 'x', text: 'x', templateKey: 'password_reset' })
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
          sendMail({ to: recipient, subject: 'x', text: 'x', templateKey: 'password_reset' })
        ).resolves.toBeUndefined()
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
            subject: 'x',
            text: 'x',
            templateKey: 'password_reset',
          })
        ).resolves.toBeUndefined()
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('failed')
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })
})
