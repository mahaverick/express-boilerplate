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
import { extractErrorCode, redactedMailErrorForLog } from '@/services/mailer.service'

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
})
