/**
 * @file `handle()` is every controller's error path. Express 5 would
 * forward a rejected promise on its own; these pin the wrapper's own
 * contract: sync and async failures reach `next`, a failure after
 * headers were sent still reaches `next` without a second write, and
 * success never calls `next`.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseController, type Handler } from '@/controllers/base.controller'
import { logger } from '@/services/logger.service'

/**
 * A concrete controller that exposes `handle` to the test.
 */
class ProbeController extends BaseController {
  /**
   * Makes the protected `handle` callable from a test.
   */
  wrap(handler: Handler): Handler {
    return this.handle(handler)
  }
}

/**
 * A handler that throws synchronously, so no promise is returned.
 */
function throwSync(): void {
  throw new Error('sync failure')
}

/**
 * A handler that fails asynchronously, before any response is written.
 */
async function rejectAsync(): Promise<void> {
  await Promise.resolve()
  throw new Error('async failure')
}

/**
 * A handler that fails after it has already sent a response.
 */
async function sendThenReject(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ ok: true })
  await Promise.resolve()
  throw new Error('late failure')
}

/**
 * A handler that sends a response asynchronously and succeeds.
 */
async function sendThenResolve(_request: Request, response: Response): Promise<void> {
  await Promise.resolve()
  response.status(200).json({ ok: true })
}

const controller = new ProbeController()
const request = {} as Request

/**
 * The response double and the spies on its `status` and `json` writes.
 */
interface FakeResponse {
  response: Response
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

/**
 * A response double that records writes; `json` flips `headersSent`, as Express does.
 */
function fakeResponse(): FakeResponse {
  const state = { headersSent: false }
  const json = vi.fn(() => {
    state.headersSent = true
  })
  const fake = {
    get headersSent() {
      return state.headersSent
    },
    json,
    status: vi.fn(),
  }
  fake.status.mockReturnValue(fake)
  return { response: fake as unknown as Response, status: fake.status, json }
}

/**
 * A `next` spy whose argument reads as `unknown`, with a reader for the
 * argument of its last call.
 */
function mockNext(): {
  next: NextFunction
  spy: ReturnType<typeof vi.fn>
  lastArgument: () => unknown
} {
  const spy = vi.fn<(error?: unknown) => void>()
  return { next: spy, spy, lastArgument: () => spy.mock.calls.at(-1)?.[0] }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BaseController.handle', () => {
  it('forwards a synchronous throw to next and returns a promise', async () => {
    const { response } = fakeResponse()
    const { next, spy, lastArgument } = mockNext()

    const result = controller.wrap(throwSync)(request, response, next)

    expect(result).toBeInstanceOf(Promise)
    await result
    expect(spy).toHaveBeenCalledTimes(1)
    expect((lastArgument() as Error).message).toBe('sync failure')
  })

  it('forwards an async rejection to next, and the returned promise resolves', async () => {
    const { response } = fakeResponse()
    const { next, spy, lastArgument } = mockNext()

    await expect(controller.wrap(rejectAsync)(request, response, next)).resolves.toBeUndefined()

    expect(spy).toHaveBeenCalledTimes(1)
    expect((lastArgument() as Error).message).toBe('async failure')
  })

  it('still calls next when headers were already sent, and never writes a second response', async () => {
    const { response, status, json } = fakeResponse()
    const { next, spy, lastArgument } = mockNext()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await controller.wrap(sendThenReject)(request, response, next)

    expect(spy).toHaveBeenCalledTimes(1)
    expect((lastArgument() as Error).message).toBe('late failure')
    expect(status).toHaveBeenCalledTimes(1)
    expect(json).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Handler failed after headers were sent')
  })

  it('does not log the warning when headers were not sent', async () => {
    const { response } = fakeResponse()
    const { next } = mockNext()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await controller.wrap(rejectAsync)(request, response, next)

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not call next or write again after a handler sends and resolves', async () => {
    const { response, status, json } = fakeResponse()
    const { next, spy } = mockNext()

    await controller.wrap(sendThenResolve)(request, response, next)

    expect(spy).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledTimes(1)
    expect(json).toHaveBeenCalledTimes(1)
  })

  it('passes request, response and next through to the handler unchanged', async () => {
    const { response } = fakeResponse()
    const { next } = mockNext()
    const inner = vi.fn<Handler>()

    await controller.wrap(inner)(request, response, next)

    expect(inner).toHaveBeenCalledWith(request, response, next)
  })
})
