/**
 * @file Integration test: touches the real per-worker Postgres database
 * (through `EmailLogRepository`) and the real Mailpit container (SMTP on
 * 1025, its own HTTP API on 8025 or `MAILPIT_URL`), never mocked. See
 * CLAUDE.md on why a test like this must live under `tests/integration/`,
 * never `tests/unit/`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
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
import { renderSignInLinkTemplate } from '@/templates/email/sign-in-link.template'
import { renderStepUpLinkTemplate } from '@/templates/email/step-up-link.template'
import { renderWelcomeTemplate } from '@/templates/email/welcome.template'
import {
  assertNoMailpitMessage,
  deleteMailpitMessage,
  findMailpitMessages,
  getMailpitMessage,
} from '../../helpers/mailpit'
import { withMutatedMethod, withMutatedModule } from '../../helpers/mutate'

const emailLogRepository = new EmailLogRepository()

/**
 * Returns an address unique to one test, tagged with `label` so a stray row traces back to its
 * test.
 */
function uniqueRecipient(label: string): string {
  return `mailer-service-${label}-${randomUUID()}@example.test`
}

/**
 * Returns valid `StepUpLinkVariables` for a test that needs some valid
 * step_up_link message and does not care about its content. Each call has a
 * fresh `confirmUrl`, so two calls in one test never share a token-shaped value.
 */
function validStepUpLinkVariables(): {
  firstName: string
  confirmUrl: string
  expiresInMinutes: string
  expiresAt: string
  appName: string
} {
  return {
    firstName: 'Ada',
    confirmUrl: `https://example.test/auth/confirm?token=${randomUUID()}`,
    expiresInMinutes: '15',
    expiresAt: '15:42 UTC on 20 October 2026',
    appName: 'Test App',
  }
}

/**
 * A stub of nodemailer's promise-form `sendMail(data): Promise<T>`.
 * Nodemailer's own `sendMail` (`node_modules/nodemailer/dist/cjs/mailer/index.d.ts`;
 * nodemailer 10 ships first-party types) is a two-way overload that also has a
 * callback form, `sendMail(data, callback): void`. A stub implementing only
 * the promise form is not structurally assignable to that overloaded type, so
 * `withMutatedMethod`'s `implementation` parameter needs a cast at each call
 * site below. That is a type-system limit of stubbing an overloaded
 * third-party method, not a loosening of what the stub does at runtime: every
 * test drives it through the promise overload, the only one `mailer.service.ts`'s
 * `sendMail` calls.
 */
type StubbedSendMail = (mailOptions: unknown) => Promise<{
  messageId: string
  envelope: unknown
  accepted: unknown[]
  rejected: unknown[]
  pending: unknown[]
  response: string
}>

/**
 * A `sendMail` stub that always rejects with a connection error (`ECONNECTION`).
 * The stubs below sit at module scope rather than inline in each test
 * (`unicorn/consistent-function-scoping`) because none captures anything
 * test-local, unlike `rejectWithLeakyMessage`, which closes over a token and
 * body generated per test and stays where it is used.
 */
const rejectWithConnectionError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Connection refused'), { code: 'ECONNECTION' })
  return Promise.reject(error)
}

/**
 * A `sendMail` stub that resolves with canned delivery info and never touches Mailpit.
 */
const resolveWithFakeInfo: StubbedSendMail = () =>
  Promise.resolve({
    messageId: 'fake-message-id',
    envelope: {},
    accepted: [],
    rejected: [],
    pending: [],
    response: '',
  })

/**
 * A `sendMail` stub that always rejects with an SMTP authentication error (`EAUTH`).
 */
const rejectWithAuthError: StubbedSendMail = () => {
  const error = Object.assign(new Error('Invalid login'), { code: 'EAUTH' })
  return Promise.reject(error)
}

/**
 * A `sendMail` stub that rejects with a string, which has no `.code` to extract.
 */
// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- deliberately a non-Error rejection, to prove extractErrorCode never assumes an object shape
const rejectWithAString: StubbedSendMail = () => Promise.reject('smtp exploded')

/**
 * `EmailLogRepository.record` with the width normalization removed: a plain
 * insert of `entry` as given. It lets the "redacts a real failed delivery-log
 * write" test reach a genuine Postgres 22001 through `sendMail`, since
 * `record()` replaces an over-width `templateKey`, `recipient` or
 * `providerMessageId` before inserting (`email-log.repository.ts`). Same
 * technique as `recordWithLengthOnlyGuard` in
 * `tests/integration/repositories/email-log-error-code-shape-mutation.test.ts`:
 * keep the error real and bypass only the guard that would intercept it.
 */
async function recordWithoutNormalization(entry: NewEmailLog): Promise<EmailLog> {
  const [row] = await db.insert(emailLogModel).values(entry).returning()
  if (row === undefined) throw new HttpError('Insert returned no row', 500)
  return row
}

/**
 * "Resolves identically for a recipient regardless of transport failure" is
 * asserted at the service boundary: no request handler calls `sendMail`
 * directly; mail reaches it through the queue (`email.worker.ts`).
 *
 * `sendMail` renders internally: `MailMessage` is `{ to, templateKey,
 * variables }`, never pre-rendered subject, text or html (see `MailMessage`'s
 * JSDoc in `mailer.service.ts`). Every call below supplies `variables` for a
 * real template rather than literal `subject` or `text` strings.
 */
describe('sendMail', () => {
  const createdLogIds: string[] = []

  afterEach(async () => {
    if (createdLogIds.length === 0) return
    await sql`delete from email_logs where id = any(${createdLogIds})`
    createdLogIds.length = 0
  })

  /**
   * Proves a real send reaches Mailpit and is retrievable through its HTTP
   * API. The test covers the success branch against a real provider and the
   * outcome record for it: a `'sent'` row with a real `providerMessageId` and
   * no body text.
   *
   * The Subject assertion is computed independently, by calling
   * `renderStepUpLinkTemplate` directly with the same variables rather than
   * comparing to a literal, so it proves the Subject Mailpit received is the
   * template's own output and not something the caller supplied.
   */
  it('sends a real, template-rendered message that Mailpit receives, and records it as sent', async () => {
    const recipient = uniqueRecipient('real-send')
    const variables = validStepUpLinkVariables()
    const expectedSubject = renderStepUpLinkTemplate(variables).subject

    await sendMail({ to: recipient, templateKey: 'step_up_link', variables })

    const messages = await findMailpitMessages(recipient)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.Subject).toBe(expectedSubject)
    expect(messages[0]?.To[0]?.Address).toBe(recipient)
    if (messages[0]) await deleteMailpitMessage(messages[0].ID)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('sent')
    expect(rows[0]?.templateKey).toBe('step_up_link')
    expect(rows[0]?.providerMessageId).toBeTruthy()
    expect(rows[0]?.errorCode).toBeNull()
    /**
     * The delivery log records that a mail was sent, never what it said: no
     * rendered content, not even the confirm URL, reaches this table (see
     * `email-log.model.ts`'s header comment).
     */
    expect(JSON.stringify(rows[0])).not.toContain(variables.confirmUrl)
  })

  /**
   * `renderForMessage`'s switch (`mailer.service.ts`) has one case per
   * template, and the other tests exercise it through `'step_up_link'`
   * and the unknown-key default. This drives `sign_in_link`, `step_up_link` and
   * `welcome` through the real `sendMail`, one call per template
   * (not a loop over a mixed-shape array, which would need an `any` to pair
   * each `templateKey` with its own variables type; the discriminated union
   * proves that pairing at compile time, in
   * `tests/unit/services/mailer.service.test.ts`). It also shows that a
   * template's logged `templateKey` and its delivered Subject agree with each
   * other and differ across templates.
   *
   * The sends run one after another, with an explicit longer timeout: sends
   * run concurrently through the one shared transporter (`getMailTransporter`
   * in `mailer.config.ts`, one per process) fail against the real Mailpit
   * container with `command: 'CONN'` connection errors. Three SMTP round
   * trips plus three Mailpit search polls in sequence can exceed the
   * suite's default 20 s per-test timeout (`vite.config.ts`), hence the
   * override below.
   */
  it('dispatches every templateKey to its own template — sent Subject and logged templateKey always agree', async () => {
    const signInRecipient = uniqueRecipient('dispatch-sign-in-link')
    const signInVariables = {
      firstName: 'Grace',
      signInUrl: `https://example.test/auth/link?token=${randomUUID()}`,
      expiresInMinutes: '15',
      expiresAt: '15:42 UTC on 20 October 2026',
      appName: 'Test App',
      reason: 'self' as const,
    }
    await sendMail({ to: signInRecipient, templateKey: 'sign_in_link', variables: signInVariables })
    const signInMessages = await findMailpitMessages(signInRecipient)
    expect(signInMessages).toHaveLength(1)
    const expectedSignInSubject = renderSignInLinkTemplate(signInVariables).subject
    expect(signInMessages[0]?.Subject).toBe(expectedSignInSubject)
    if (signInMessages[0]) await deleteMailpitMessage(signInMessages[0].ID)
    const signInRows = await emailLogRepository.findByRecipient(signInRecipient)
    createdLogIds.push(...signInRows.map((row) => row.id))
    expect(signInRows[0]?.status).toBe('sent')
    expect(signInRows[0]?.templateKey).toBe('sign_in_link')

    const stepUpRecipient = uniqueRecipient('dispatch-step-up-link')
    const stepUpVariables = validStepUpLinkVariables()
    await sendMail({ to: stepUpRecipient, templateKey: 'step_up_link', variables: stepUpVariables })
    const stepUpMessages = await findMailpitMessages(stepUpRecipient)
    expect(stepUpMessages).toHaveLength(1)
    const expectedStepUpSubject = renderStepUpLinkTemplate(stepUpVariables).subject
    expect(stepUpMessages[0]?.Subject).toBe(expectedStepUpSubject)
    if (stepUpMessages[0]) await deleteMailpitMessage(stepUpMessages[0].ID)
    const stepUpRows = await emailLogRepository.findByRecipient(stepUpRecipient)
    createdLogIds.push(...stepUpRows.map((row) => row.id))
    expect(stepUpRows[0]?.status).toBe('sent')
    expect(stepUpRows[0]?.templateKey).toBe('step_up_link')

    const welcomeRecipient = uniqueRecipient('dispatch-welcome')
    const welcomeVariables = {
      firstName: 'Alan',
      signInUrl: `https://example.test/auth/link?token=${randomUUID()}`,
      expiresInMinutes: '15',
      expiresAt: '15:42 UTC on 20 October 2026',
      appName: 'Test App',
    }
    await sendMail({ to: welcomeRecipient, templateKey: 'welcome', variables: welcomeVariables })
    const welcomeMessages = await findMailpitMessages(welcomeRecipient)
    expect(welcomeMessages).toHaveLength(1)
    const expectedWelcomeSubject = renderWelcomeTemplate(welcomeVariables).subject
    expect(welcomeMessages[0]?.Subject).toBe(expectedWelcomeSubject)
    if (welcomeMessages[0]) await deleteMailpitMessage(welcomeMessages[0].ID)
    const welcomeRows = await emailLogRepository.findByRecipient(welcomeRecipient)
    createdLogIds.push(...welcomeRows.map((row) => row.id))
    expect(welcomeRows[0]?.status).toBe('sent')
    expect(welcomeRows[0]?.templateKey).toBe('welcome')

    /**
     * Distinct subjects rule out every branch rendering the same thing and
     * passing this test silently.
     */
    expect(
      new Set([expectedSignInSubject, expectedStepUpSubject, expectedWelcomeSubject]).size
    ).toBe(3)
  }, 40_000)

  /**
   * Asserted at the service boundary rather than over HTTP, for the reason in the file's `describe`
   * comment above.
   */
  it('resolves identically for a recipient regardless of transport failure', async () => {
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
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
          }),
          sendMail({
            to: unknownLikeRecipient,
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
          }),
        ])

        /**
         * Both calls fulfil although the transport rejects every time. A
         * `sendMail` that let the rejection propagate would make both promises
         * reject with the identical error, and `toStrictEqual` below cannot
         * tell "both fulfilled" from "both rejected the same way".
         */
        expect(existingOutcome.status).toBe('fulfilled')
        expect(unknownOutcome.status).toBe('fulfilled')
        /**
         * The settlement is identical whichever recipient it was for: direct equality, not "both
         * happen to be OK".
         */
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

  /**
   * Rendering runs inside `sendMail`'s own try/catch, so a missing-variable
   * failure cannot defeat the identical-resolution guarantee that the test
   * above proves for transport failure. This mirrors that test for a
   * rendering failure.
   *
   * The failure is injected through `withMutatedModule`
   * (`tests/helpers/mutate.ts`) at the template's render function, the way the
   * transport test injects it at the transporter's `sendMail`, and not by
   * building malformed `variables`: both calls use valid, well-typed messages.
   * Nothing under `src/` is edited.
   */
  it('resolves identically for a recipient regardless of a rendering failure — the same property proven above for transport failure', async () => {
    const existingLikeRecipient = uniqueRecipient('render-fail-existing')
    const unknownLikeRecipient = uniqueRecipient('render-fail-unknown')

    await withMutatedModule(
      '@/templates/email/step-up-link.template',
      {
        renderStepUpLinkTemplate: () => {
          throw new Error('a variable present on only one enumeration branch was missing')
        },
      },
      () => import('@/services/mailer.service'),
      async (mailerServiceModule) => {
        const [existingOutcome, unknownOutcome] = await Promise.allSettled([
          mailerServiceModule.sendMail({
            to: existingLikeRecipient,
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
          }),
          mailerServiceModule.sendMail({
            to: unknownLikeRecipient,
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
          }),
        ])

        /**
         * Same assertions as the transport-failure test above: both fulfil
         * (a propagated rendering exception would make both reject
         * identically, which `toStrictEqual` alone cannot tell apart from both
         * fulfilling) and the settlement is identical whichever the recipient.
         */
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

    /**
     * Neither recipient received anything: a rendering failure sends nothing under any label.
     */
    await assertNoMailpitMessage(existingLikeRecipient)
    await assertNoMailpitMessage(unknownLikeRecipient)
  })

  /**
   * `MailMessage` is a discriminated union (`mailer.service.ts`), so a typed
   * caller cannot pair a `templateKey` with the wrong `variables`, which
   * `tests/unit/services/mailer.service.test.ts` proves at compile time. This
   * is the runtime counterpart for a caller that bypasses the types (`as
   * unknown as MailMessage`): a `templateKey` that matches no template never
   * sends a wrong body under it. Rendering fails and nothing is sent.
   */
  it('a templateKey that matches no real template fails loudly and sends nothing, rather than sending mismatched content', async () => {
    const recipient = uniqueRecipient('unknown-template-key')
    const bogusMessage = {
      to: recipient,
      templateKey: 'not_a_real_template',
      variables: { firstName: 'Ada' },
    } as unknown as MailMessage

    /**
     * No transport mutation is needed: `renderForMessage`'s default branch
     * throws before the transport is reached, so the real transporter is never
     * touched.
     */
    await expect(sendMail(bogusMessage)).resolves.toBe('failed')

    await assertNoMailpitMessage(recipient)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.status).toBe('failed')
    /**
     * The declared key is logged as attempted and failed, not substituted or dropped.
     */
    expect(rows[0]?.templateKey).toBe('not_a_real_template')
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })

  /**
   * `tests/unit/templates/email/*.test.ts` exercises each template's render
   * function directly. This is the same escaping property through the
   * `sendMail` boundary: a dangerous value in `variables`, driven through the
   * real transport to real Mailpit delivery, confirming the HTML Mailpit
   * stored is escaped and not merely what a template function returns alone.
   */
  it('escapes a dangerous variable in the real HTML Mailpit receives, through sendMail end to end', async () => {
    const recipient = uniqueRecipient('escaping-through-sendmail')
    const payload = '<img src=x onerror=alert(1)>'

    await sendMail({
      to: recipient,
      templateKey: 'step_up_link',
      variables: { ...validStepUpLinkVariables(), firstName: payload },
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
    // The plain-text part is not HTML: it must carry the raw value.
    expect(detail.Text).toContain(payload)

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
  })

  /**
   * A failed delivery-log write must not fail the send: by the time the row is written the mail has
   * already gone out.
   */
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
            /**
             * The transport call succeeds (`resolveWithFakeInfo`, mutated
             * above) and only the delivery-log write fails. `recordDelivery`
             * keeps that failure from affecting what `sendMail` reports, so
             * this resolves `'sent'`.
             */
            await expect(
              sendMail({
                to: recipient,
                templateKey: 'step_up_link',
                variables: validStepUpLinkVariables(),
              })
            ).resolves.toBe('sent')
          }
        )
      }
    )
    // No row to clean up: the (mutated) write never landed one, by construction.
  })

  /**
   * `recordDelivery` must never log the raw error from a failed `record()`
   * call: a Drizzle query error whose bound parameters include
   * `entry.recipient`, an email address (PII). This proves that against a real
   * failing insert, not a synthetic error shape.
   *
   * Width normalization (`email-log.repository.ts`) keeps `recipient`,
   * `templateKey` and `providerMessageId` from reaching the database over-width
   * through the success path, and an over-width `templateKey` is unreachable
   * there at all: on success `entry.templateKey` is always
   * `rendered.templateKey`, a template-owned constant, never caller-supplied.
   * The vehicle for a genuine 22001 through `sendMail` is therefore
   * `recipient`, which needs no cast (an over-length `to` is type-safe), with
   * `record()`'s normalization bypassed through `recordWithoutNormalization`.
   */
  it('redacts a real failed delivery-log write, dropping the recipient PII it would otherwise log', async () => {
    const transporter = getMailTransporter()
    // > MAX_EMAIL_LENGTH (320): email-log.model.ts's recipient width.
    const overWidthRecipient = `${'a'.repeat(400)}@example.test`

    /**
     * `vi.spyOn` on `logger.error`, not a plain reassignment: `logger` is a
     * module-scope object exported from `logger.service.ts`, so spying on it
     * is reliable. `.mockRestore()` runs in a `finally` because the vitest
     * config sets neither `restoreMocks` nor `mockReset` (the reason
     * `tests/helpers/mutate.ts` restores in a `finally` too), so nothing else
     * undoes this spy if the test does not.
     */
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
              /**
               * As in the "still resolves when recording the delivery log
               * fails" test above: the transport call succeeds and only the
               * unnormalized insert fails, so this resolves `'sent'`.
               */
              await expect(
                sendMail({
                  to: overWidthRecipient,
                  templateKey: 'step_up_link',
                  variables: validStepUpLinkVariables(),
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
      /**
       * The recipient address appears nowhere in what was logged, as a top-level field or inside a
       * bound parameter.
       */
      expect(JSON.stringify(logged)).not.toContain(overWidthRecipient)
      /**
       * The driver's SQLSTATE code (22001, string data right truncation)
       * survives, so the line was redacted, not dropped, and says what
       * failed.
       */
      expect(logged?.error?.driverCode).toBeDefined()
    } finally {
      loggerErrorSpy.mockRestore()
    }
    // No row to clean up (the insert failed) and no message to clean up (resolveWithFakeInfo never touches Mailpit).
  })

  /**
   * The failure-path half of the leak proof (the success path, a caller
   * passing a raw `errorCode` directly to `record()`, is covered in
   * `tests/integration/repositories/email-log.repository.test.ts`, with its mutation proof in
   * `email-log-error-code-shape-mutation.test.ts`):
   * a transport rejection whose own message embeds a raw token and the
   * rendered body, the realistic shape of an SMTP rejection that echoes
   * content back, must never reach the table. `extractErrorCode`
   * (`mailer.service.ts`) reads only `.code`.
   */
  it('never lets an error message or the message body reach the delivery log or the log stream', async () => {
    const transporter = getMailTransporter()
    const recipient = uniqueRecipient('leak-proof')
    const rawToken = randomBytes(32).toString('hex')
    const confirmUrl = `https://example.test/auth/confirm?token=${rawToken}`
    const leakyMessage = `550 rejected: message body contained "Confirm it's you: ${confirmUrl}"`

    /**
     * A `sendMail` stub that rejects with an error whose message holds the raw token and the
     * rendered body.
     */
    const rejectWithLeakyMessage: StubbedSendMail = () => Promise.reject(new Error(leakyMessage))

    /**
     * Covers `sendMail`'s send-path catch, the one that receives the SMTP
     * server's echoed reply, distinct from `recordDelivery`'s own redaction,
     * which has its own test above. Reverting `redactedMailErrorForLog(error)`
     * to plain `error` in the send-path catch would leave every other test in
     * this file passing, so this test is the only one pinning that catch.
     * `vi.spyOn(logger, 'error')` rather than a plain reassignment, for the
     * reason given in the test above.
     */
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
              templateKey: 'step_up_link',
              variables: {
                firstName: 'Ada',
                confirmUrl,
                expiresInMinutes: '15',
                expiresAt: '15:42 UTC on 20 October 2026',
                appName: 'Test App',
              },
            })
          ).resolves.toBe('failed')
        }
      )

      /**
       * Read the table directly, not `record()`'s return value or `findByRecipient`: a proof that
       * reads back its own argument shows nothing about what landed on disk.
       */
      const [row] = await sql`select * from email_logs where recipient = ${recipient}`
      if (row) createdLogIds.push(row.id as string)

      expect(row).toBeDefined()
      /**
       * The recipient is the address actually mailed, not derived from the error.
       */
      expect(row?.recipient).toBe(recipient)
      expect(row?.error_code).toBe(UNKNOWN_ERROR_CODE)
      const serializedRow = JSON.stringify(row)
      expect(serializedRow).not.toContain(rawToken)
      expect(serializedRow).not.toContain(confirmUrl)
      expect(serializedRow).not.toContain('550 rejected')

      /**
       * The log-stream half: what reached `logger.error` for the send failure
       * (not `recordDelivery`'s 'Failed to record email delivery log' line,
       * which this test never triggers because the log write succeeds).
       *
       * `util.inspect`, not `JSON.stringify`, on the captured payload:
       * `JSON.stringify(new Error('...'))` is `"{}"` because an Error's own
       * `message` and `stack` are non-enumerable, so a `JSON.stringify` check
       * would report clean whether or not the code redacted anything.
       * `util.inspect` is what Node's console uses for a non-string argument,
       * so it shows an Error's message the way an operator's terminal would.
       */
      const sendFailureCall = capturedErrorCalls.find((call) => call[0] === 'Mail send failed')
      expect(sendFailureCall).toBeDefined()
      const inspectedLogged = inspect(sendFailureCall?.[1], { depth: null })
      expect(inspectedLogged).not.toContain(rawToken)
      expect(inspectedLogged).not.toContain(confirmUrl)
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
          templateKey: 'step_up_link',
          variables: validStepUpLinkVariables(),
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
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
          })
        ).resolves.toBe('failed')
      }
    )

    const rows = await emailLogRepository.findByRecipient(recipient)
    createdLogIds.push(...rows.map((row) => row.id))
    expect(rows[0]?.errorCode).toBe(UNKNOWN_ERROR_CODE)
  })

  /**
   * `getMailTransporter()` sits inside `sendMail`'s try (`mailer.service.ts`),
   * so a throw while creating the transporter is also recorded as a failed
   * send instead of rejecting. Hoisting the call above the try would be an
   * innocent-looking refactor that reopens that path, and every other test in
   * this file would stay green, because they all mutate an already-created
   * transporter's `sendMail` and never the creation step.
   * `withMutatedMethod` cannot reach it, since no transporter exists to mutate
   * before creation, so this uses `withMutatedModule`: `getMailTransporter` is
   * imported by value, not a shared prototype method, which is the shape
   * `withMutatedModule` is for.
   */
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
            templateKey: 'step_up_link',
            variables: validStepUpLinkVariables(),
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
