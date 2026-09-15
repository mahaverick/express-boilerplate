// tests/unit/middlewares/error.middleware.test.ts
import { DrizzleQueryError } from 'drizzle-orm'
import { type Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { errorHandler, HttpError } from '@/middlewares/error.middleware'

/**
 * Build a minimal mock Express response, enough for errorHandler to call
 * `.status().json()` and `.getHeader()` against.
 *
 * The mock functions are returned as their own properties, not read back off
 * `response` in assertions — `response` is typed as `Response`, and
 * `@typescript-eslint/unbound-method` flags any reference to one of its
 * methods taken as a value rather than called, which `toHaveBeenCalledWith`
 * would otherwise trigger.
 * @returns The mock response, its captured JSON body, and the `status` spy.
 */
function mockResponse(): { response: Response; body: () => unknown; status: Mock } {
  let captured: unknown
  const status = vi.fn().mockReturnThis()
  const response = {
    getHeader: vi.fn().mockReturnValue('req-id-1'),
    status,
    json: vi.fn().mockImplementation((body: unknown) => {
      captured = body
      return response
    }),
  } as unknown as Response
  return { response, body: () => captured, status }
}

describe('errorHandler', () => {
  // Every 5xx path now logs — spy on console.error for the whole suite so
  // that logging is silenced in test output by default, and so the one test
  // below that cares can assert on it without every other test needing to.
  let consoleError: Mock

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
    // Node's own system errors (ENOENT, ECONNREFUSED, ...) and many
    // third-party errors already carry a `.code` string. Only an HttpError's
    // OWN, deliberately-set `code` is client-facing — forwarding any
    // foreign error's `.code` here would leak internal detail the same way
    // an unmasked message would.
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

  it('logs the original error for a non-HttpError, not just the masked message', () => {
    // The client-facing contract (masked message, 500) is covered above.
    // This is the other half of that same failure: a 5xx must not vanish
    // without a trace an operator can search for and a bug report can cite.
    const { response, body, status } = mockResponse()
    const original = new Error('leaked implementation detail')
    errorHandler(original, {} as never, response, vi.fn())

    expect(status).toHaveBeenCalledWith(500)
    expect(body()).toMatchObject({ success: false, message: 'Internal server error' })
    // The ORIGINAL error object is logged, not the masked message — masking
    // is for the client; the whole point of logging is that the real cause
    // stays recoverable server-side.
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), original)
  })

  it('does not log a client error (4xx)', () => {
    const { response } = mockResponse()
    errorHandler(new HttpError('bad input', 400), {} as never, response, vi.fn())

    expect(consoleError).not.toHaveBeenCalled()
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

  // A failed database write is the one 5xx that arrives carrying the data it
  // was trying to write. drizzle-orm builds DrizzleQueryError's message as
  // `Failed query: ${query}\nparams: ${params}` (verified against
  // node_modules/drizzle-orm/errors.js), so `console.error(error)` used to
  // print a registrant's email address and bcrypt hash into the log on any
  // insert failure that is not the unique violation BaseRepository already
  // turns into a 409 — an over-length email (22001), for instance.
  //
  // The real class is constructed here, not a hand-rolled look-alike: the
  // handler matches this shape structurally (so the error contract takes no
  // runtime dependency on the ORM), and this test is what pins that
  // structural match to the actual class it is meant to catch.
  describe('a failed database query', () => {
    const email = 'victim@example.com'
    const passwordHash = '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR'

    /**
     * Build the error drizzle's postgres-js driver actually throws for a
     * failed insert, wrapping a driver error carrying a SQLSTATE code.
     * @returns The query error, carrying real credentials as bound parameters.
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

      const logged = JSON.stringify(consoleError.mock.calls)
      expect(logged).not.toContain(email)
      expect(logged).not.toContain(passwordHash)
      expect(logged).not.toContain('params:')
    })

    it('still logs the query text and the driver code, so the 500 stays diagnosable', () => {
      const { response } = mockResponse()

      errorHandler(failedInsert(), {} as never, response, vi.fn())

      expect(consoleError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          query: 'insert into "users" ("email", "password_hash") values ($1, $2) returning *',
          driverCode: '22001',
        })
      )
    })

    it('redacts a query-shaped error that carries neither a driver code nor a stack', () => {
      // The defensive edges of the same path: a query error whose cause is
      // not an object with a `code` (a dropped connection surfaces one), and
      // one with no usable stack. Neither may fall back to logging the raw
      // error — the message embeds the parameters either way.
      const { response } = mockResponse()
      const bare = { query: 'select 1 from "users" where "email" = $1', params: [email] }

      errorHandler(bare, {} as never, response, vi.fn())

      expect(consoleError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ driverCode: undefined, stack: undefined, paramCount: 1 })
      )
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(email)
    })

    // Fix round 2 (task-2-review.md, finding 8): `stackFramesOf` used to
    // filter with `line.trimStart().startsWith('at ')`, which drops the one
    // signal (V8's own indentation of at least four spaces on every genuine
    // frame) that tells a real call frame apart from a message line that
    // merely happens to start with those two characters. A query error's
    // own message embeds the SQL text and can be multi-line, and is not
    // fully attacker-controlled here — but the fix is the same either way,
    // and this pins it directly rather than by absence.
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

      expect(consoleError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          stack: '    at Object.<anonymous> (/app/src/repositories/user.repository.ts:42:11)',
        })
      )
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
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

  // Express's body parser throws `http-errors` instances, not HttpError.
  // tests/integration/api/body-parser.test.ts drives the real thing through
  // supertest; these pin the branch behaviour directly, including the cases
  // a real body-parser error never produces.
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
      expect(consoleError).not.toHaveBeenCalled()
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
      // The whole point of the expose flag: a library error that merely
      // happens to carry a 4xx status must not hand its internal message to
      // the client.
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
      // Honouring it would skip the masking below and could leak an internal
      // message; 5xx stays the handler's own decision.
      const { response, body, status } = mockResponse()
      errorHandler(
        Object.assign(new Error('internal detail'), { status: 503, expose: true }),
        {} as never,
        response,
        vi.fn()
      )

      expect(status).toHaveBeenCalledWith(500)
      expect(body()).toMatchObject({ message: 'Internal server error' })
      expect(consoleError).toHaveBeenCalled()
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
