/**
 * @file Covers the stream handler's registry bookkeeping where a socket
 * cannot reach: a client that is already gone when the handler runs, and a
 * server-initiated close that happens with no request 'close' event.
 */
import type { NextFunction, Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notificationStreamController } from '@/controllers/notification-stream.controller'
import { countAllStreams, resetLifecycleForTests } from '@/services/lifecycle.service'

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
} {
  const writeHead = vi.fn()
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
    on: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true
    }),
  } as unknown as Response
  return { request, response, writeHead }
}

describe('notificationStreamController.streamNotifications', () => {
  afterEach(() => {
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
})
