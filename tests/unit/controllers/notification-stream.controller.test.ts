/**
 * @file Covers the stream handler's registry bookkeeping where a socket
 * cannot reach: a client that is already gone when the handler runs, and a
 * server-initiated close that happens with no request 'close' event.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEnv } from '@/configs/env.config'
import { notificationStreamController } from '@/controllers/notification-stream.controller'
import { countAllStreams, resetLifecycleForTests } from '@/services/lifecycle.service'
import { isSessionDenied } from '@/services/session-denylist.service'

vi.mock('@/services/session-denylist.service', () => ({ isSessionDenied: vi.fn() }))
// The real emitter opens a Redis subscriber whose connect timer would race the timer-count checks.
vi.mock('@/services/notification-emitter.service', () => ({
  onNotification: vi.fn(),
  offNotification: vi.fn(),
}))

/**
 * Build a fake request and response pair for an authenticated stream call.
 * @param options - Whether the client is already gone, and when the token expires.
 * @param options.isGone - True when the request and response are already destroyed.
 * @param options.isRequestDestroyed - True when only the request is destroyed, as Node does once a body is fully read.
 * @param options.expiresAt - The access token's expiry.
 * @returns The fakes, with the response's `writeHead` spy.
 */
function buildCall(options: { isGone: boolean; isRequestDestroyed?: boolean; expiresAt?: Date }): {
  request: Request
  response: Response
  writeHead: ReturnType<typeof vi.fn>
  emitResponse: (event: string) => void
  end: ReturnType<typeof vi.fn>
} {
  const responseHandlers = new Map<string, (() => void)[]>()
  const writeHead = vi.fn()
  const end = vi.fn()
  const request = {
    user: { id: 'user-a' },
    sessionId: 'session-a',
    accessTokenExpiresAt: options.expiresAt,
    destroyed: options.isGone || options.isRequestDestroyed === true,
    get: vi.fn(),
    on: vi.fn(),
  } as unknown as Request
  const response = {
    writableEnded: false,
    destroyed: options.isGone,
    writableLength: 0,
    writeHead,
    on: vi.fn((event: string, handler: () => void) => {
      responseHandlers.set(event, [...(responseHandlers.get(event) ?? []), handler])
    }),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end,
  } as unknown as Response
  const emitResponse = (event: string): void => {
    const handlers = responseHandlers.get(event) ?? []
    for (const handler of handlers) handler()
  }
  return { request, response, writeHead, emitResponse, end }
}

describe('notificationStreamController.streamNotifications', () => {
  afterEach(() => {
    vi.mocked(isSessionDenied).mockReset()
    vi.useRealTimers()
    resetLifecycleForTests()
  })

  it('registers nothing and writes nothing for a client that is already gone', async () => {
    vi.useFakeTimers()
    const { request, response, writeHead } = buildCall({ isGone: true })
    const next = vi.fn() as unknown as NextFunction

    await notificationStreamController.streamNotifications(request, response, next)

    expect(countAllStreams()).toBe(0)
    expect(writeHead).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still opens the stream when only the request is destroyed (its body was fully read)', async () => {
    const { request, response, writeHead } = buildCall({ isGone: false, isRequestDestroyed: true })

    await notificationStreamController.streamNotifications(request, response, vi.fn())

    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' })
    )
    expect(countAllStreams()).toBe(1)
  })

  it('frees the registry slot when the expiry timer closes the stream', async () => {
    vi.useFakeTimers()
    const { request, response } = buildCall({
      isGone: false,
      expiresAt: new Date(Date.now() + 1000),
    })

    await notificationStreamController.streamNotifications(request, response, vi.fn())
    expect(countAllStreams()).toBe(1)

    // No request 'close' is emitted: the close path must unregister by itself.
    await vi.advanceTimersByTimeAsync(1500)
    expect(countAllStreams()).toBe(0)
  })

  it('tears down when the response closes, though the request closed long before', async () => {
    vi.useFakeTimers()
    const { request, response, emitResponse } = buildCall({
      isGone: false,
      isRequestDestroyed: true,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await notificationStreamController.streamNotifications(request, response, vi.fn())
    expect(countAllStreams()).toBe(1)

    emitResponse('close')
    expect(countAllStreams()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('frees the registry slot when the heartbeat finds the session denied', async () => {
    vi.useFakeTimers()
    vi.mocked(isSessionDenied).mockResolvedValue(true)
    const { request, response, end } = buildCall({ isGone: false })

    await notificationStreamController.streamNotifications(request, response, vi.fn())
    expect(countAllStreams()).toBe(1)

    await vi.advanceTimersByTimeAsync(getEnv().SSE_HEARTBEAT_INTERVAL_MS)
    expect(countAllStreams()).toBe(0)
    expect(end).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
