/**
 * @file What `errorHandler` hands error tracking: the capture rule's
 * decision for each kind of 5xx, the `errorId` shared by the body and the
 * log line, the `http` context (route template, status, request id), the
 * scrubbed span record (also with error tracking off), and the headers-sent
 * and client-abort branches. The reporter is spied: these tests pin the
 * wiring, not what the reporter sends.
 */
import type { Span } from '@opentelemetry/api'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { uuidv7 } from '@posthog/core/vendor/uuidv7'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'
import { errorHandler } from '@/middlewares/error.middleware'
import { UNMATCHED_ROUTE } from '@/middlewares/route-template.middleware'
import * as reporter from '@/services/errors/error-reporter.service'
import { logger } from '@/services/logger.service'

const actualReporter = vi.hoisted(
  (): {
    reportError?: typeof import('@/services/errors/error-reporter.service').reportError
  } => ({})
)

vi.mock('@/services/errors/error-reporter.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/errors/error-reporter.service')>()
  actualReporter.reportError = actual.reportError
  return {
    ...actual,
    reportError: vi.fn(() => 'reported-error-id'),
    scrubbedErrorForSpan: vi.fn(() => ({ name: 'Error', message: 'scrubbed' })),
  }
})

vi.mock('@posthog/core/vendor/uuidv7', () => ({ uuidv7: vi.fn(() => 'fresh-error-id') }))

/**
 * A mock response whose `getHeader` answers the request id.
 * @param isHeadersSent - Whether the headers are already sent.
 * @returns The response and its captured body.
 */
function mockResponse(isHeadersSent = false): { response: Response; body: () => unknown } {
  let captured: unknown
  const response = {
    headersSent: isHeadersSent,
    getHeader: vi.fn().mockReturnValue('req-id-1'),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockImplementation((body: unknown) => {
      captured = body
      return response
    }),
  } as unknown as Response
  return { response, body: () => captured }
}

/**
 * A request with a method and a live or destroyed socket.
 * @param isSocketDestroyed - Whether the client's socket is already gone.
 * @returns The request and its socket's `destroy` spy.
 */
function mockRequest(isSocketDestroyed = false): { request: Request; destroy: Mock } {
  const destroy = vi.fn()
  const request = { method: 'POST', socket: { destroyed: isSocketDestroyed, destroy } }
  return { request: request as unknown as Request, destroy }
}

describe('errorHandler and error tracking', () => {
  let loggerError: Mock<typeof logger.error>

  beforeEach(() => {
    loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(reporter.reportError).mockClear()
    vi.mocked(uuidv7).mockClear()
    vi.mocked(reporter.scrubbedErrorForSpan).mockClear()
  })

  it('reports an unexpected throw as http, and puts its id in the body and the log line', () => {
    const { response, body } = mockResponse()
    const { request } = mockRequest()
    const error = new Error('boom')

    errorHandler(error, request, response, vi.fn())

    expect(reporter.reportError).toHaveBeenCalledExactlyOnceWith(error, {
      capturePoint: 'http',
      handled: true,
      http: { method: 'POST', route: UNMATCHED_ROUTE, status: 500, requestId: 'req-id-1' },
    })
    expect(body()).toMatchObject({ statusCode: 500, errorId: 'reported-error-id' })
    expect(loggerError).toHaveBeenCalledWith('Unhandled server error', {
      error,
      errorId: 'reported-error-id',
    })
  })

  // Express 5 turns `next(null)` into "no error", so only a direct call reaches the handler with null.
  it('answers a thrown null with a 500 and an errorId, and reports it once', () => {
    const { response, body } = mockResponse()
    const { request } = mockRequest()

    // eslint-disable-next-line unicorn/no-null -- the thrown value under test
    errorHandler(null, request, response, vi.fn())

    expect(reporter.reportError).toHaveBeenCalledOnce()
    expect(vi.mocked(reporter.reportError).mock.calls[0]?.[0]).toBeNull()
    expect((response as unknown as { status: Mock }).status).toHaveBeenCalledWith(500)
    expect(body()).toMatchObject({ statusCode: 500, errorId: 'reported-error-id' })
  })

  it('reports an HttpError 503 that wraps a cause', () => {
    const { response } = mockResponse()
    const { request } = mockRequest()

    errorHandler(
      new HttpError('Upstream down', 503, undefined, undefined, { cause: new Error('refused') }),
      request,
      response,
      vi.fn()
    )

    expect(reporter.reportError).toHaveBeenCalledOnce()
  })

  it('does not report an HttpError 503 without a cause, but still gives it an errorId', () => {
    const { response, body } = mockResponse()
    const { request } = mockRequest()

    errorHandler(new HttpError('Server is shutting down', 503), request, response, vi.fn())

    expect(reporter.reportError).not.toHaveBeenCalled()
    expect(body()).toMatchObject({ statusCode: 503, errorId: 'fresh-error-id' })
    expect(loggerError).toHaveBeenCalledWith('Unhandled server error', {
      error: expect.any(HttpError) as unknown,
      errorId: 'fresh-error-id',
    })
  })

  it('does not report or log a TimelineUnavailableError, even with a cause, but gives it an errorId', () => {
    const { response, body } = mockResponse()
    const { request } = mockRequest()
    const error = new TimelineUnavailableError()
    Object.assign(error, { cause: new Error('PostHog refused') })

    errorHandler(error, request, response, vi.fn())

    expect(reporter.reportError).not.toHaveBeenCalled()
    expect(loggerError).not.toHaveBeenCalled()
    expect(body()).toMatchObject({ statusCode: 502, errorId: 'fresh-error-id' })
  })

  it.each([
    ['an HttpError 404', new HttpError('Not found', 404)],
    ['a validation 400', new HttpError('Validation failed', 400, undefined, { email: ['bad'] })],
    ['a body-parser 413', Object.assign(new Error('too large'), { status: 413 })],
  ])('neither reports %s nor gives it an errorId', (_name, error) => {
    const { response, body } = mockResponse()
    const { request } = mockRequest()

    errorHandler(error, request, response, vi.fn())

    expect(reporter.reportError).not.toHaveBeenCalled()
    expect(uuidv7).not.toHaveBeenCalled()
    expect(body()).not.toHaveProperty('errorId')
  })

  it('records the scrubbed error on the active span and marks it an error, only when reported', () => {
    const span = { recordException: vi.fn(), setStatus: vi.fn() }
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as unknown as Span)
    const { request } = mockRequest()
    const error = new Error('user@example.test broke it')

    errorHandler(error, request, mockResponse().response, vi.fn())
    errorHandler(
      new HttpError('Server is shutting down', 503),
      request,
      mockResponse().response,
      vi.fn()
    )

    expect(reporter.scrubbedErrorForSpan).toHaveBeenCalledExactlyOnceWith(error)
    expect(span.recordException).toHaveBeenCalledExactlyOnceWith({
      name: 'Error',
      message: 'scrubbed',
    })
    expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: SpanStatusCode.ERROR })
  })

  it('still records the span with error tracking off, where the real reporter sends nothing', () => {
    const report = actualReporter.reportError
    if (report === undefined) throw new Error('the real reportError was not captured')
    vi.mocked(reporter.reportError).mockImplementationOnce(report)
    const span = { recordException: vi.fn(), setStatus: vi.fn() }
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as unknown as Span)
    const { response, body } = mockResponse()

    errorHandler(new Error('boom'), mockRequest().request, response, vi.fn())

    expect(span.recordException).toHaveBeenCalledOnce()
    expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: SpanStatusCode.ERROR })
    expect((body() as { errorId?: unknown }).errorId).toEqual(expect.any(String))
  })

  it('reports a failure after the headers were sent as a 500, logs its id and destroys the socket', () => {
    const { response } = mockResponse(true)
    const { request, destroy } = mockRequest()
    const error = new Error('stream write failed')

    errorHandler(error, request, response, vi.fn())

    expect(reporter.reportError).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({
        capturePoint: 'http',
        http: expect.objectContaining({ status: 500 }) as unknown,
      })
    )
    expect(loggerError).toHaveBeenCalledWith('Error after response headers were sent', {
      error,
      errorId: 'reported-error-id',
    })
    expect(destroy).toHaveBeenCalledOnce()
  })

  it.each([
    ['ECONNRESET', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['aborted', new Error('aborted')],
  ])('does not report a client abort (%s) on a destroyed socket', (_name, error) => {
    const { request } = mockRequest(true)

    errorHandler(error, request, mockResponse(true).response, vi.fn())
    errorHandler(error, request, mockResponse().response, vi.fn())

    expect(reporter.reportError).not.toHaveBeenCalled()
  })

  it('still reports a connection-reset error while the client socket is open', () => {
    const { request } = mockRequest(false)
    const error = Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' })

    errorHandler(error, request, mockResponse().response, vi.fn())

    expect(reporter.reportError).toHaveBeenCalledOnce()
  })
})
