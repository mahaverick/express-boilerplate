/**
 * @file extractErrorCode and redactedMailErrorForLog, the two pure helpers of
 * mailer.service.ts, called with hand-built error values so that every branch
 * runs, including ones a real SMTP failure rarely reaches (a rejection with no
 * `.stack`, one whose stack has no frame lines); and the compile-time shape of
 * `MailMessage`. `sendMail` touches the real transporter and the delivery log,
 * so it is covered in tests/integration/services/mailer.service.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { UNKNOWN_ERROR_CODE } from '@/database/models/email-log.model'
import {
  extractErrorCode,
  redactedMailErrorForLog,
  type MailMessage,
} from '@/services/mailer.service'

describe('extractErrorCode', () => {
  it('reads a real nodemailer-shaped code', () => {
    expect(extractErrorCode({ code: 'ECONNECTION' })).toBe('ECONNECTION')
  })

  it('returns UNKNOWN_ERROR_CODE when there is no .code', () => {
    expect(extractErrorCode(new Error('boom'))).toBe(UNKNOWN_ERROR_CODE)
  })

  it('returns UNKNOWN_ERROR_CODE when .code is present but not a string', () => {
    expect(extractErrorCode({ code: 500 })).toBe(UNKNOWN_ERROR_CODE)
  })

  it('returns UNKNOWN_ERROR_CODE for a non-object rejection', () => {
    expect(extractErrorCode('smtp exploded')).toBe(UNKNOWN_ERROR_CODE)
    // eslint-disable-next-line unicorn/no-null -- exercising extractErrorCode's own `error === null` branch
    expect(extractErrorCode(null)).toBe(UNKNOWN_ERROR_CODE)
    expect(extractErrorCode(undefined)).toBe(UNKNOWN_ERROR_CODE)
  })

  // Never reads .message or .response, even when they are the only place a code-shaped value appears: this keeps a leaked token or body fragment out of email_logs.error_code.
  it('never reads .message or .response, even when they contain something code-shaped', () => {
    const error = { message: 'ECONNECTION', response: 'EAUTH' }
    expect(extractErrorCode(error)).toBe(UNKNOWN_ERROR_CODE)
  })
})

describe('redactedMailErrorForLog', () => {
  it('passes a non-object rejection through unchanged — nothing to redact from a primitive', () => {
    expect(redactedMailErrorForLog('smtp exploded')).toBe('smtp exploded')
    // eslint-disable-next-line unicorn/no-null -- exercising redactedMailErrorForLog's own `error === null` branch
    expect(redactedMailErrorForLog(null)).toBeNull()
  })

  it('keeps name/code/command/responseCode, and drops message/response entirely', () => {
    const error = Object.assign(new Error('550 rejected: contains a secret token'), {
      code: 'EENVELOPE',
      command: 'RCPT TO',
      responseCode: 550,
      response: '550 rejected: contains a secret token',
    })

    const redacted = redactedMailErrorForLog(error) as Record<string, unknown>
    expect(redacted.name).toBe('Error')
    expect(redacted.code).toBe('EENVELOPE')
    expect(redacted.command).toBe('RCPT TO')
    expect(redacted.responseCode).toBe(550)
    expect(JSON.stringify(redacted)).not.toContain('a secret token')
  })

  it('keeps the call frames of a real stack, with the message line stripped', () => {
    const error = new Error('550 rejected: contains a secret token')
    const redacted = redactedMailErrorForLog(error) as { stack?: string }
    expect(redacted.stack).toBeDefined()
    expect(redacted.stack).not.toContain('a secret token')
    expect(redacted.stack).toContain('at ')
  })

  it('leaves `stack` undefined when the error has no .stack at all', () => {
    const redacted = redactedMailErrorForLog({ code: 'ECONNECTION' }) as { stack?: string }
    expect(redacted.stack).toBeUndefined()
  })

  it.each([
    ['an indented `at` line', `550 rejected\n    at secret-token-should-not-survive`],
    [
      'a frame-shaped line',
      `550 rejected\n    at secret-token-should-not-survive (/app/src/x.ts:1:1)`,
    ],
  ])('drops a message line that forms %s, keeping the real frames', (_name, message) => {
    const redacted = redactedMailErrorForLog(new Error(message)) as { stack?: string }
    expect(redacted.stack).toBeDefined()
    expect(redacted.stack).not.toContain('secret-token-should-not-survive')
    expect(redacted.stack).toMatch(/^ {4}at /)
  })

  it('leaves `stack` undefined when .stack has no usable "at " frame lines', () => {
    const redacted = redactedMailErrorForLog({ stack: 'Error: just a message, no frames' }) as {
      stack?: string
    }
    expect(redacted.stack).toBeUndefined()
  })

  /**
   * The frame filter requires a V8 frame's shape, which starts with
   * indentation, to tell a real call frame from an unindented line that
   * merely starts with "at ". `.stack` begins with the error's message, which
   * can include an SMTP server's multi-line response, so this matters; it is
   * pinned directly, not by absence.
   */
  it('drops an unindented line that merely begins "at ", keeping only real indented call frames', () => {
    const craftedStack = [
      'Error: 550 rejected',
      'at RCPT TO: 550 rejected — secret-token-should-not-survive',
      '    at Object.<anonymous> (/app/src/services/mailer.service.ts:10:5)',
    ].join('\n')
    const redacted = redactedMailErrorForLog({ stack: craftedStack }) as { stack?: string }
    expect(redacted.stack).toBe(
      '    at Object.<anonymous> (/app/src/services/mailer.service.ts:10:5)'
    )
    expect(redacted.stack).not.toContain('secret-token-should-not-survive')
  })
})

/**
 * `MailMessage` is a discriminated union on `templateKey` (see its JSDoc in
 * mailer.service.ts), so a caller cannot construct one whose `templateKey` and
 * `variables` disagree, and cannot supply `subject`/`text`/`html` at all. All
 * three properties below are compile-time only: no assertion can check them,
 * and `tsc` either reports "Unused '@ts-expect-error' directive" or it does
 * not (`pnpm lint` runs tsconfig.typecheck.json's tsc over this file). The
 * same `@ts-expect-error` pattern is used for `NewUserToken['purpose']` in
 * tests/unit/database/models/user-token.model.test.ts.
 */
describe('MailMessage', () => {
  const validPasswordResetVariables = {
    firstName: 'Ada',
    resetUrl: 'https://example.test/reset',
    appName: 'Test App',
  }

  it('a template key outside EmailTemplateKey is a compile error', () => {
    const invalid: MailMessage = {
      to: 'user@example.test',
      // @ts-expect-error — templateKey is closed to EmailTemplateKey's literals; a typo (hyphen instead of underscore) must fail to compile, not silently build a message logged under a key no template ever renders. TS reports the error on the property's own line, so the directive sits directly above it.
      templateKey: 'password-reset',
      variables: validPasswordResetVariables,
    }
    // A real assertion, not a throwaway: see the comment in tests/unit/database/models/user-token.model.test.ts on why a compile-time check needs one genuine read of the value.
    expect(invalid.templateKey).toBe('password-reset')
  })

  // `variables` shaped for a different template (RegistrationAttemptVariables: firstName and appName, no resetUrl) paired with `templateKey: 'password_reset'` must not compile, so a caller cannot construct that mismatch.
  it('variables shaped for a different template than the declared templateKey is a compile error', () => {
    // @ts-expect-error — PasswordResetVariables requires `resetUrl`; the `variables` object below is RegistrationAttemptVariables-shaped instead. TS reports the mismatched-union-member error on the object literal's own declaration line, so the directive sits directly above it.
    const invalid: MailMessage = {
      to: 'user@example.test',
      templateKey: 'password_reset',
      variables: { firstName: 'Ada', appName: 'Test App' },
    }
    expect(invalid.templateKey).toBe('password_reset')
  })

  // MailMessage has no subject, text or html field, so a caller has no message field to put a token into; a caller-supplied `subject` alongside an otherwise valid message must not compile.
  it('a caller-supplied subject is a compile error — there is no field to reopen the old token-in-subject risk', () => {
    const invalid: MailMessage = {
      to: 'user@example.test',
      templateKey: 'password_reset',
      variables: validPasswordResetVariables,
      // @ts-expect-error — MailMessage carries no subject/text/html field at all; every message's content comes from renderForMessage (mailer.service.ts), never from a caller.
      subject: 'a caller-chosen subject',
    }
    expect(invalid.templateKey).toBe('password_reset')
  })
})
