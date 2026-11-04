/**
 * @file Client kind resolution: `X-Client: native` marks a native app, any
 * other value is a browser, and a native request that carries browser
 * headers, or a browser request that carries a refresh token in its body, is
 * refused with a 400.
 */
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vite-plus/test'
import { HttpError } from '@/errors/http-error'
import { isNativeRequest, resolveClientKind } from '@/middlewares/native-client.middleware'

/**
 * A request carrying the given headers (lowercase names) and body, read
 * through `request.headers` and `request.get`.
 */
function requestWith(headers: Record<string, string>, body: unknown = {}): Request {
  return {
    headers,
    body,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request
}

/**
 * Runs the middleware once and returns the request and what `next` got.
 */
function run(
  headers: Record<string, string>,
  body?: unknown
): { request: Request; next: ReturnType<typeof vi.fn> } {
  const request = requestWith(headers, body)
  const next = vi.fn()
  resolveClientKind(request, {} as Response, next)
  return { request, next }
}

describe('resolveClientKind', () => {
  it('sets native for X-Client: native with no browser headers', () => {
    const { request, next } = run({ 'x-client': 'native' })

    expect(request.clientKind).toBe('native')
    expect(isNativeRequest(request)).toBe(true)
    expect(next).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([undefined, 'Native', 'ios'])('sets web when X-Client is %s', (value) => {
    const { request, next } = run(value === undefined ? {} : { 'x-client': value })

    expect(request.clientKind).toBe('web')
    expect(isNativeRequest(request)).toBe(false)
    expect(next).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['https://a.test', 'null', ''])('refuses native with Origin %j', (origin) => {
    const { next } = run({ 'x-client': 'native', origin })

    const error = next.mock.calls[0]?.[0] as HttpError
    expect(error).toBeInstanceOf(HttpError)
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe('NATIVE_CLIENT_REFUSED')
  })

  it.each(['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'])(
    'refuses native with %s',
    (header) => {
      const { next } = run({ 'x-client': 'native', [header]: 'cors' })

      const error = next.mock.calls[0]?.[0] as HttpError
      expect(error).toBeInstanceOf(HttpError)
      expect(error.statusCode).toBe(400)
      expect(error.code).toBe('NATIVE_CLIENT_REFUSED')
    }
  )

  it('refuses a web request whose body has refreshToken', () => {
    const { next } = run({}, { refreshToken: 'a'.repeat(64) })

    const error = next.mock.calls[0]?.[0] as HttpError
    expect(error).toBeInstanceOf(HttpError)
    expect(error.statusCode).toBe(400)
    expect(error.code).toBe('REFRESH_TOKEN_IN_BODY')
  })

  it('lets a native request carry refreshToken in its body', () => {
    const { request, next } = run({ 'x-client': 'native' }, { refreshToken: 'a'.repeat(64) })

    expect(request.clientKind).toBe('native')
    expect(next).toHaveBeenCalledExactlyOnceWith()
  })
})
