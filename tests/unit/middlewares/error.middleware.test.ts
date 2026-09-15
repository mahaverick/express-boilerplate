// tests/unit/middlewares/error.middleware.test.ts
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
