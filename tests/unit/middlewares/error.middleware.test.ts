import type { Span } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'
import { ErrorPropertiesBuilder } from '@posthog/core/error-tracking'
import { DrizzleQueryError } from 'drizzle-orm'
import { type Request, type Response } from 'express'
import postgres from 'postgres'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { PosthogUnavailableError } from '@/errors/posthog-errors'
import { errorHandler } from '@/middlewares/error.middleware'
import {
  queuedErrorReportCount,
  reportErrorWithSpan,
  resetErrorReporter,
} from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'
import { requestContextStore } from '@/services/request-context.service'

const tracking = vi.hoisted(() => ({ isEnabled: false }))

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isErrorTrackingEnabled: () => tracking.isEnabled }
})

vi.mock('@/services/errors/error-counters.service', () => ({
  countErrorOutcome: vi.fn(() => Promise.resolve()),
  recordErrorSendOk: vi.fn(() => Promise.resolve()),
  recordErrorSendError: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/services/errors/error-reporter.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/errors/error-reporter.service')>()
  return { ...actual, reportErrorWithSpan: vi.fn(actual.reportErrorWithSpan) }
})

/**
 * A minimal mock Express response, enough for errorHandler to call
 * `.status().json()` and `.getHeader()` against, with a reader for the JSON
 * body and the `status` spy.
 *
 * The `status` spy is returned as its own property, not read back off
 * `response` in assertions: `response` is typed as `Response`, and
 * `@typescript-eslint/unbound-method` flags any reference to one of its
 * methods taken as a value rather than called, which `toHaveBeenCalledWith`
 * would otherwise trigger.
 */
function mockResponse(): { response: Response; body: () => unknown; status: Mock } {
  let captured: unknown
  const status = vi.fn().mockReturnThis()
  const response = {
    getHeader: vi.fn().mockReturnValue('req-id-1'),
    set: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    status,
    json: vi.fn().mockImplementation((body: unknown) => {
      captured = body
      return response
    }),
  } as unknown as Response
  return { response, body: () => captured, status }
}

describe('errorHandler', () => {
  // Most 5xx paths log: spy on logger.error for the whole suite so that logging is silenced in test output by default, and so a test that cares can assert on it without every other test needing to.
  let loggerError: Mock<typeof logger.error>

  beforeEach(() => {
    loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(reportErrorWithSpan).mockClear()
  })

  it('uses HttpError.statusCode and message for a client error', () => {
    const { response, body, status } = mockResponse()
    errorHandler(new HttpError('bad input', 400), {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(400)
    expect(body()).toMatchObject({ success: false, message: 'bad input', statusCode: 400 })
  })

  it('includes field-level errors when HttpError carries them', () => {
    const { response, body } = mockResponse()
    const fieldErrors = { email: ['is required'] }
    errorHandler(
      new HttpError('invalid', 422, undefined, fieldErrors),
      {} as never,
      response,
      vi.fn()
    )

    expect(body()).toMatchObject({ statusCode: 422, errors: fieldErrors })
  })

  it('omits the errors key when HttpError carries none', () => {
    const { response, body } = mockResponse()
    errorHandler(new HttpError('invalid', 422), {} as never, response, vi.fn())

    expect(body()).not.toHaveProperty('errors')
  })

  it('answers a PosthogUnavailableError 502 with its code and a masked message, without logging it again', () => {
    const { response, body, status } = mockResponse()
    errorHandler(new PosthogUnavailableError(), {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(502)
    expect(body()).toMatchObject({
      success: false,
      message: 'Internal server error',
      statusCode: 502,
      code: 'POSTHOG_UNAVAILABLE',
    })
    expect(loggerError).not.toHaveBeenCalled()
  })

  it('still logs a plain HttpError 502', () => {
    const { response } = mockResponse()
    errorHandler(new HttpError('upstream', 502), {} as never, response, vi.fn())

    expect(loggerError).toHaveBeenCalledWith('Unhandled server error', expect.anything())
  })

  it('includes a machine-readable code when HttpError carries one', () => {
    const { response, body } = mockResponse()
    errorHandler(
      new HttpError('Access token expired', 401, 'ACCESS_TOKEN_EXPIRED'),
      {} as never,
      response,
      vi.fn()
    )

    expect(body()).toMatchObject({ statusCode: 401, code: 'ACCESS_TOKEN_EXPIRED' })
  })

  it('sets Retry-After from an HttpError that carries retryAfterSeconds', () => {
    const { response, body } = mockResponse()
    errorHandler(
      new HttpError('Wait a moment.', 429, 'STEP_UP_LINK_COOLDOWN', undefined, {
        retryAfterSeconds: 42,
      }),
      {} as never,
      response,
      vi.fn()
    )

    // eslint-disable-next-line @typescript-eslint/unbound-method -- the mock's own vi.fn, read as a spy, never called unbound
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42')
    expect(body()).toMatchObject({ statusCode: 429, code: 'STEP_UP_LINK_COOLDOWN' })
  })

  it('sets no Retry-After on an HttpError without retryAfterSeconds', () => {
    const { response } = mockResponse()
    errorHandler(new HttpError('invalid', 400), {} as never, response, vi.fn())

    // eslint-disable-next-line @typescript-eslint/unbound-method -- the mock's own vi.fn, read as a spy, never called unbound
    expect(response.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything())
  })

  it('omits the code key when HttpError carries none', () => {
    const { response, body } = mockResponse()
    errorHandler(new HttpError('invalid', 422), {} as never, response, vi.fn())

    expect(body()).not.toHaveProperty('code')
  })

  it('carries both code and errors independently when HttpError sets both', () => {
    const { response, body } = mockResponse()
    const fieldErrors = { email: ['is required'] }
    errorHandler(
      new HttpError('invalid', 422, 'VALIDATION_FAILED', fieldErrors),
      {} as never,
      response,
      vi.fn()
    )

    expect(body()).toMatchObject({ code: 'VALIDATION_FAILED', errors: fieldErrors })
  })

  it('does not forward a foreign error carrying its own .code property', () => {
    // Node's own system errors (ENOENT, ECONNREFUSED, ...) and many third-party errors already carry a `.code` string. Only an HttpError's own, deliberately-set `code` is client-facing — forwarding any foreign error's `.code` here would leak internal detail the same way an unmasked message would.
    const { response, body } = mockResponse()
    errorHandler(
      Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      {} as never,
      response,
      vi.fn()
    )

    expect(body()).not.toHaveProperty('code')
  })

  it('masks the message and defaults to 500 for a non-HttpError', () => {
    const { response, body, status } = mockResponse()
    errorHandler(new Error('leaked implementation detail'), {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(500)
    expect(body()).toMatchObject({ success: false, message: 'Internal server error' })
  })

  it.each([
    ['22021', false],
    ['22P05', true],
  ])(
    'answers 400, masked and not captured, when Postgres refuses a character (%s)',
    (code, warns) => {
      const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const { response, body, status } = mockResponse()
      const cause = Object.assign(
        new postgres.PostgresError('invalid byte sequence for encoding'),
        { code }
      )
      errorHandler(
        new DrizzleQueryError('select * from tenants where slug = $1', ['a\u{0}b'], cause),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(400)
      expect(body()).toMatchObject({ success: false, message: 'Bad Request', statusCode: 400 })
      expect(JSON.stringify(body())).not.toContain('a\u{0}b')
      expect(loggerError).not.toHaveBeenCalled()
      expect(reportErrorWithSpan).not.toHaveBeenCalled()
      if (warns) {
        expect(loggerWarn).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('a\u{0}b')
      } else {
        expect(loggerWarn).not.toHaveBeenCalled()
      }
    }
  )

  it('logs the original error for a non-HttpError, not just the masked message', () => {
    // The client-facing contract (masked message, 500) is covered above; this is the other half of that same failure — a 5xx must not vanish without a trace an operator can search for and a bug report can cite.
    const { response, body, status } = mockResponse()
    const original = new Error('leaked implementation detail')
    errorHandler(original, {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(500)
    expect(body()).toMatchObject({ success: false, message: 'Internal server error' })
    // The ORIGINAL error object is logged, not the masked message: masking is for the client; the whole point of logging is that the real cause stays recoverable server-side.
    expect(loggerError).toHaveBeenCalledWith('Unhandled server error', {
      error: original,
      errorId: expect.any(String) as unknown,
    })
  })

  it('logs 5xx errors with the request-id from ALS context', () => {
    // errorHandler is called directly, with no Express request running requestContext (request-context.middleware.ts) ahead of it, so requestContextStore.run() supplies the ALS context; the logger is mocked and reads nothing from it, so this asserts only that the error is logged inside one.
    const { response } = mockResponse()
    requestContextStore.run({ requestId: 'test-req-id' }, () => {
      errorHandler(new Error('boom'), {} as never, response, vi.fn())
    })

    expect(loggerError).toHaveBeenCalled()
  })

  it('does not log a client error (4xx)', () => {
    const { response } = mockResponse()
    errorHandler(new HttpError('bad input', 400), {} as never, response, vi.fn())

    expect(loggerError).not.toHaveBeenCalled()
  })

  it('masks the message for an HttpError whose own status is 500 or above', () => {
    const { response, body } = mockResponse()
    errorHandler(new HttpError('db exploded', 500), {} as never, response, vi.fn())

    expect(body()).toMatchObject({ message: 'Internal server error', statusCode: 500 })
  })

  it('handles a thrown non-Error value', () => {
    const { response, body, status } = mockResponse()
    errorHandler('just a string', {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(500)
    expect(body()).toMatchObject({ message: 'Internal server error' })
  })

  it('stamps the request id read back off the response', () => {
    const { response, body } = mockResponse()
    errorHandler(new HttpError('nope', 404), {} as never, response, vi.fn())

    expect(body()).toMatchObject({ requestId: 'req-id-1' })
  })

  it('destroys the socket instead of writing a second response once headers are already sent', () => {
    const { response, status } = mockResponse()
    Object.assign(response, { headersSent: true })
    const destroy = vi.fn()
    const next = vi.fn()

    errorHandler(new Error('stream write failed'), { socket: { destroy } } as never, response, next)

    // Not next(error): Express's final handler console.errors the raw error, unredacted, for every NODE_ENV but 'test'.
    expect(status).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })

  /**
   * A failed database query arrives carrying the values it was bound to
   * (for a write, the data it was trying to write). drizzle-orm builds
   * DrizzleQueryError's message as `Failed query: ${query}\nparams: ${params}` (verified
   * against node_modules/drizzle-orm/errors.js), so logging the raw error
   * would print a registrant's email address and bcrypt hash into the log
   * on any insert failure that is not the unique violation
   * BaseRepository turns into a 409 — an over-length email
   * (22001), for instance. The real class is constructed here, not a
   * hand-rolled look-alike: the handler matches this shape structurally
   * (so the error contract takes no runtime dependency on the ORM), and
   * this test is what pins that structural match to the actual class it
   * is meant to catch.
   */
  describe('a failed database query', () => {
    const email = 'victim@example.com'
    const passwordHash = '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR'

    /**
     * The query error drizzle throws for a failed insert, wrapping a driver
     * error that carries a SQLSTATE code, with real credentials as bound
     * parameters.
     */
    function failedInsert(): DrizzleQueryError {
      const cause = Object.assign(new Error('value too long for type character varying(320)'), {
        code: '22001',
      })
      return new DrizzleQueryError(
        'insert into "users" ("email", "password_hash") values ($1, $2) returning *',
        [email, passwordHash],
        cause
      )
    }

    it('logs neither the bound parameters nor the message that embeds them', () => {
      const { response } = mockResponse()

      errorHandler(failedInsert(), {} as never, response, vi.fn())

      const logged = JSON.stringify(loggerError.mock.calls)
      expect(logged).not.toContain(email)
      expect(logged).not.toContain(passwordHash)
      expect(logged).not.toContain('params:')
    })

    it('still logs the query text and the driver code, so the 500 stays diagnosable', () => {
      const { response } = mockResponse()

      errorHandler(failedInsert(), {} as never, response, vi.fn())

      // Not a nested expect.objectContaining: vitest/jest types that matcher's return as `any`, and assigning it as an object-literal property (rather than passing it directly as an argument) trips @typescript-eslint/no-unsafe-assignment; reading the actual call arguments back and asserting with toMatchObject keeps this typed.
      const [, meta] = loggerError.mock.calls[0] ?? []
      expect(meta?.error).toMatchObject({
        query: 'insert into "users" ("email", "password_hash") values ($1, $2) returning *',
        driverCode: '22001',
      })
    })

    it('redacts a query-shaped error that carries neither a driver code nor a stack', () => {
      // The defensive edges of the same path: a query error whose cause is not an object with a string `code`, and one with no usable stack. Neither may fall back to logging the raw error: the message embeds the parameters either way.
      const { response } = mockResponse()
      const bare = { query: 'select 1 from "users" where "email" = $1', params: [email] }

      errorHandler(bare, {} as never, response, vi.fn())

      const [, meta] = loggerError.mock.calls[0] ?? []
      expect(meta?.error).toMatchObject({ driverCode: undefined, stack: undefined, paramCount: 1 })
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(email)
    })

    /**
     * `stackFramesOf` keeps only the lines after the message that
     * `isStackFrameLine` (stack-frames.ts) accepts: indented, `at ` and a
     * location. That tells
     * a real call frame apart from a message line that merely starts with
     * "at ". A query error's message embeds the bound parameters and can be
     * multi-line, so such a line can appear in it. This pins the filter
     * directly rather than by absence.
     */
    it('drops an unindented line that merely begins "at ", keeping only real indented call frames', () => {
      const { response } = mockResponse()
      const craftedStack = [
        'Error: Failed query',
        'at RCPT TO: 550 rejected — secret-token-should-not-survive',
        '    at Object.<anonymous> (/app/src/repositories/user.repository.ts:42:11)',
      ].join('\n')
      const queryShaped = {
        query: 'select 1 from "users" where "email" = $1',
        params: [email],
        stack: craftedStack,
      }

      errorHandler(queryShaped, {} as never, response, vi.fn())

      const [, meta] = loggerError.mock.calls[0] ?? []
      expect(meta?.error).toMatchObject({
        stack: '    at Object.<anonymous> (/app/src/repositories/user.repository.ts:42:11)',
      })
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
        'secret-token-should-not-survive'
      )
    })

    it('answers the client the same masked 500 as any other unexpected error', () => {
      const { response, body, status } = mockResponse()

      errorHandler(failedInsert(), {} as never, response, vi.fn())

      expect(status).toHaveBeenCalledWith(500)
      expect(body()).toMatchObject({ success: false, message: 'Internal server error' })
      expect(JSON.stringify(body())).not.toContain(email)
    })
  })

  /**
   * Express's body parser throws `http-errors` instances, not HttpError.
   * tests/integration/api/body-parser.test.ts drives the real thing
   * through supertest; these pin the branch behaviour directly, including
   * the cases a real body-parser error never produces.
   */
  describe('a foreign error carrying a status (http-errors shape)', () => {
    it('honours .status in the 4xx range and exposes an expose:true message', () => {
      const { response, body, status } = mockResponse()
      const bodyParserError = Object.assign(new SyntaxError('Unexpected token }'), {
        status: 400,
        statusCode: 400,
        expose: true,
      })
      errorHandler(bodyParserError, {} as never, response, vi.fn())

      expect(status).toHaveBeenCalledWith(400)
      expect(body()).toMatchObject({ message: 'Unexpected token }', statusCode: 400 })
      expect(loggerError).not.toHaveBeenCalled()
    })

    it('honours .statusCode when .status is absent', () => {
      const { response, status } = mockResponse()
      errorHandler(
        Object.assign(new Error('too big'), { statusCode: 413, expose: true }),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(413)
    })

    it('replaces the message with the reason phrase when expose is not true', () => {
      // The whole point of the expose flag: a library error that merely happens to carry a 4xx status must not hand its internal message to the client.
      const { response, body, status } = mockResponse()
      errorHandler(
        Object.assign(new Error('pg: relation "users" does not exist'), { status: 403 }),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(403)
      expect(body()).toMatchObject({ message: 'Forbidden', statusCode: 403 })
    })

    it('does not trust a 5xx status from a foreign error', () => {
      // Only 400-499 is honoured: a foreign 5xx stays the handler's own 500, masked and logged.
      const { response, body, status } = mockResponse()
      errorHandler(
        Object.assign(new Error('internal detail'), { status: 503, expose: true }),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(500)
      expect(body()).toMatchObject({ message: 'Internal server error' })
      expect(loggerError).toHaveBeenCalled()
    })

    it('ignores a non-integer or out-of-range status', () => {
      const { response, status } = mockResponse()
      errorHandler(
        Object.assign(new Error('nonsense'), { status: 'teapot' }),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(500)
    })

    it('carries no errors key — field-level detail stays an HttpError feature', () => {
      const { response, body } = mockResponse()
      errorHandler(
        Object.assign(new Error('bad'), { status: 422, expose: true, errors: { a: ['b'] } }),
        {} as never,
        response,
        vi.fn()
      )

      expect(body()).not.toHaveProperty('errors')
    })
  })
})

describe('errorHandler with error tracking on', () => {
  afterEach(() => {
    tracking.isEnabled = false
    resetErrorReporter()
    vi.restoreAllMocks()
  })

  it('builds once per 5xx', () => {
    tracking.isEnabled = true
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const span = {
      recordException: vi.fn(),
      setStatus: vi.fn(),
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
    } as unknown as Span
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span)
    const build = vi.spyOn(ErrorPropertiesBuilder.prototype, 'buildFromUnknown')
    const response = {
      headersSent: false,
      getHeader: vi.fn().mockReturnValue('req-1'),
      set: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const request = { method: 'GET', socket: { destroyed: false } } as unknown as Request
    errorHandler(new Error('boom'), request, response, vi.fn())
    expect(queuedErrorReportCount()).toBe(1)
    expect(build).toHaveBeenCalledTimes(1)
  })
})
