// tests/unit/utilities/response.utilities.test.ts
import { type Response } from 'express'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { REQUEST_ID_HEADER } from '@/middlewares/request-id.middleware'
import { errorResponse, messageResponse, successResponse } from '@/utilities/response.utilities'

/**
 * Build a minimal mock Express response, enough to assert on `.status()`,
 * `.json()` and `.getHeader()` calls.
 *
 * The `status` spy is returned as its own property, not read back off
 * `response` in assertions — `response` is typed as `Response`, and
 * `@typescript-eslint/unbound-method` flags any reference to one of its
 * methods taken as a value rather than called, which `toHaveBeenCalledWith`
 * would otherwise trigger.
 * @returns The mock response, its captured JSON body, and the `status` spy.
 */
function mockResponse(): {
  response: Response
  body: () => unknown
  status: Mock
  getHeader: Mock
} {
  let captured: unknown
  const status = vi.fn().mockReturnThis()
  const getHeader = vi.fn().mockReturnValue('req-id-2')
  const response = {
    getHeader,
    status,
    json: vi.fn().mockImplementation((body: unknown) => {
      captured = body
      return response
    }),
  } as unknown as Response
  return { response, body: () => captured, status, getHeader }
}

describe('successResponse', () => {
  it('defaults to a 200 with a generic message', () => {
    const { response, body, status } = mockResponse()
    successResponse(response, { id: 1 })

    expect(status).toHaveBeenCalledWith(200)
    expect(body()).toEqual({ success: true, message: 'Success', statusCode: 200, data: { id: 1 } })
  })

  it('accepts a custom message and status', () => {
    const { response, body, status } = mockResponse()
    successResponse(response, { id: 1 }, 'Created', 201)

    expect(status).toHaveBeenCalledWith(201)
    expect(body()).toMatchObject({ message: 'Created', statusCode: 201 })
  })
})

describe('messageResponse', () => {
  it('sends data: null, never an omitted data key', () => {
    const { response, body, status } = mockResponse()
    messageResponse(response, 'Logged out.')

    expect(status).toHaveBeenCalledWith(200)
    expect(body()).toStrictEqual({
      success: true,
      message: 'Logged out.',
      statusCode: 200,
      // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
      data: null,
    })
  })

  it('accepts a status', () => {
    const { response, body, status } = mockResponse()
    messageResponse(response, 'Accepted.', 202)

    expect(status).toHaveBeenCalledWith(202)
    expect(body()).toStrictEqual({
      success: true,
      message: 'Accepted.',
      statusCode: 202,
      // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
      data: null,
    })
  })
})

describe('errorResponse', () => {
  it('sends the given status, unlike successResponse it has no default', () => {
    const { response, body, status } = mockResponse()
    errorResponse(response, 'boom', 500)

    expect(status).toHaveBeenCalledWith(500)
    expect(body()).toEqual({
      success: false,
      message: 'boom',
      statusCode: 500,
      requestId: 'req-id-2',
    })
  })

  it('includes field-level errors when supplied', () => {
    const { response, body, status } = mockResponse()
    const fieldErrors = { email: ['is required'] }
    errorResponse(response, 'invalid', 422, undefined, fieldErrors)

    expect(status).toHaveBeenCalledWith(422)
    expect(body()).toMatchObject({ statusCode: 422, errors: fieldErrors })
  })

  it('omits the errors key when none are supplied', () => {
    const { response, body } = mockResponse()
    errorResponse(response, 'invalid', 422)

    expect(body()).not.toHaveProperty('errors')
  })

  it('includes a code when supplied, independent of errors', () => {
    const { response, body } = mockResponse()
    errorResponse(response, 'Access token expired', 401, 'ACCESS_TOKEN_EXPIRED')

    expect(body()).toMatchObject({ statusCode: 401, code: 'ACCESS_TOKEN_EXPIRED' })
    // No field-level detail was supplied, so errors must stay absent even
    // though code is present — the two are independent fields, not one
    // overloaded one.
    expect(body()).not.toHaveProperty('errors')
  })

  it('omits the code key when none is supplied', () => {
    const { response, body } = mockResponse()
    errorResponse(response, 'invalid', 422)

    expect(body()).not.toHaveProperty('code')
  })

  it('includes both code and errors when both are supplied', () => {
    const { response, body } = mockResponse()
    const fieldErrors = { email: ['is required'] }
    errorResponse(response, 'invalid', 422, 'VALIDATION_FAILED', fieldErrors)

    expect(body()).toMatchObject({ code: 'VALIDATION_FAILED', errors: fieldErrors })
  })

  it('reads the correlation id off the response via the shared header constant', () => {
    // Guards Finding 3: the header name must have exactly one spelling.
    // Asserting via the exported constant, not the literal 'X-Request-Id',
    // means this test cannot pass if the two ever drift apart.
    const { response, body, getHeader } = mockResponse()
    errorResponse(response, 'boom', 500)

    expect(getHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER)
    expect(body()).toMatchObject({ requestId: 'req-id-2' })
  })
})
