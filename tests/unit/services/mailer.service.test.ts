// tests/unit/services/mailer.service.test.ts
//
// Unit tests for mailer.service.ts's two pure, exported helpers —
// extractErrorCode and redactedMailErrorForLog. `sendMail` itself has no
// pure-function surface (it always touches the real transporter and the
// real delivery log), so it is exercised end to end in
// tests/integration/services/mailer.service.test.ts instead; these two
// helpers are unit-tested directly, with hand-built error values,
// specifically so every branch — including ones a real SMTP round trip
// would rarely or never reach (a rejection with no `.stack` at all, one
// whose stack has no frame lines) — is exercised without needing a real
// network failure to shape one.
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

  // Never reads .message or .response, even when they are the ONLY place a
  // real code-shaped value appears — this is the actual property that keeps
  // a leaked token or body fragment out of email_logs.error_code (see this
  // function's own comment).
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

  it('leaves `stack` undefined when .stack has no usable "at " frame lines', () => {
    const redacted = redactedMailErrorForLog({ stack: 'Error: just a message, no frames' }) as {
      stack?: string
    }
    expect(redacted.stack).toBeUndefined()
  })

  // Fix round 2 (task-2-review.md, finding 8): the frame filter used to be
  // `line.trimStart().startsWith('at ')`, which drops V8's own indentation
  // (at least four spaces on every genuine frame) — the one signal that
  // tells a real call frame apart from an UNINDENTED line that merely
  // happens to start with those two characters. `.stack` is server-derived
  // here (nodemailer builds it from the rejection, which for an SMTP
  // failure can echo server-controlled, multi-line content), so this
  // matters. Pinned directly, not by absence.
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

// Task 3's addendum item 1: `MailMessage.templateKey` closes from Task 2's
// unconstrained `string` into `EmailTemplateKey`. Task 3 fix round 1 went
// further: `MailMessage` is now a discriminated union on `templateKey`
// (mailer.service.ts's own header comment), so a caller cannot construct
// one whose `templateKey` and `variables` disagree, and cannot supply
// `subject`/`text`/`html` at all. All three properties below are
// compile-time-only — no assertion can check them, `tsc` either reports
// "Unused '@ts-expect-error' directive" or it doesn't (pnpm lint runs
// tsconfig.typecheck.json's tsc over this file). Mirrors
// tests/unit/database/models/user-token.model.test.ts's own
// `@ts-expect-error` pattern for `NewUserToken['purpose']`.
describe('MailMessage', () => {
  const validPasswordResetVariables = {
    firstName: 'Ada',
    resetUrl: 'https://example.test/reset',
    appName: 'Test App',
  }

  it('a template key outside EmailTemplateKey is a compile error', () => {
    const invalid: MailMessage = {
      to: 'user@example.test',
      // @ts-expect-error — templateKey is closed to EmailTemplateKey's
      // three literals; a typo (hyphen instead of underscore) must fail to
      // compile, not silently build a message logged under a key no
      // template ever renders. TS reports a wrong-type property error on
      // the property's own line, not the object literal's declaration
      // line — the directive has to sit directly above this line to be
      // consumed.
      templateKey: 'password-reset',
      variables: validPasswordResetVariables,
    }
    // A real assertion, not a throwaway — see
    // tests/unit/database/models/user-token.model.test.ts's own comment on
    // why the compile-time check needs one genuine read of the value.
    expect(invalid.templateKey).toBe('password-reset')
  })

  // Fix round 1 on Task 3: the "logged templateKey cannot disagree with the
  // rendered content" hole. `variables` shaped for a DIFFERENT template
  // (this is exactly RegistrationAttemptVariables — firstName/appName, no
  // resetUrl) paired with `templateKey: 'password_reset'` must not compile
  // — proving a caller cannot construct the mismatch the old flat
  // `{ templateKey, variables: SomeVariables }` shape would have allowed.
  it('variables shaped for a different template than the declared templateKey is a compile error', () => {
    // @ts-expect-error — PasswordResetVariables requires `resetUrl`; the
    // `variables` object below is RegistrationAttemptVariables-shaped
    // instead. TS reports a mismatched-union-member error on the object
    // literal's own declaration line, not the `variables:` property line
    // (unlike a simple wrong-type property) — the directive has to sit
    // directly above this line to be consumed. If this stops erroring,
    // `MailMessage` has regressed to accepting any variables shape for any
    // key — the exact key/content mismatch this fix round closed.
    const invalid: MailMessage = {
      to: 'user@example.test',
      templateKey: 'password_reset',
      variables: { firstName: 'Ada', appName: 'Test App' },
    }
    expect(invalid.templateKey).toBe('password_reset')
  })

  // Fix round 1 on Task 3: "no token may appear in a subject line" is now
  // unenforceable-by-construction (mailer.service.ts's own header comment)
  // — there is no field left for a caller to put a token into. This pins
  // that claim: a caller-supplied `subject` alongside an otherwise-valid
  // message must not compile.
  it('a caller-supplied subject is a compile error — there is no field to reopen the old token-in-subject risk', () => {
    const invalid: MailMessage = {
      to: 'user@example.test',
      templateKey: 'password_reset',
      variables: validPasswordResetVariables,
      // @ts-expect-error — MailMessage carries no subject/text/html field
      // at all; every message's content comes from renderForMessage
      // (mailer.service.ts), never from a caller. If this stops erroring,
      // a caller-suppliable subject has been reintroduced.
      subject: 'a caller-chosen subject',
    }
    expect(invalid.templateKey).toBe('password_reset')
  })
})
