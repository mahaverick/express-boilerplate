/**
 * @file The Origin check on the two cookie-reading auth routes: a request
 * with no Origin, one the browser marks same-origin, and one from a
 * configured frontend pass; any other Origin is refused 403.
 */
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const WEB_URL = 'https://app.example.com'
const APEX_URL = 'https://admin.example.com/console'
const CORS_ALLOWED_ORIGINS = 'https://shop.example.com, https://docs.example.com/'

/**
 * Load the middleware against a fixed environment.
 * @param env - The variables isAllowedOrigin reads.
 * @param env.APEX_URL - Apex's public origin, if set.
 * @param env.CORS_ALLOWED_ORIGINS - The extra allowed origins, if set.
 * @returns The middleware.
 */
async function load(
  env: { APEX_URL?: string; CORS_ALLOWED_ORIGINS?: string } = {}
): Promise<typeof import('@/middlewares/origin.middleware').requireAllowedOriginWhenPresent> {
  vi.doMock('@/configs/env.config', () => ({
    getEnv: () => ({
      WEB_URL,
      APEX_URL: env.APEX_URL,
      CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    }),
  }))
  const module = await import('@/middlewares/origin.middleware')
  return module.requireAllowedOriginWhenPresent
}

/**
 * A request carrying the given headers, read through `request.get`.
 * @param headers - Lowercase header names and values.
 * @returns The request.
 */
function requestWith(headers: Record<string, string>): Request {
  return {
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request
}

/**
 * Run the middleware once and return what it passed to `next`.
 * @param middleware - The middleware under test.
 * @param headers - The request's headers.
 * @returns The argument `next` received: undefined to continue, else the rejection.
 */
function run(
  middleware: Awaited<ReturnType<typeof load>>,
  headers: Record<string, string>
): unknown {
  const next = vi.fn<(error?: unknown) => void>()
  middleware(requestWith(headers), {} as Response, next)
  expect(next).toHaveBeenCalledTimes(1)
  return next.mock.calls[0]?.[0]
}

describe('requireAllowedOriginWhenPresent', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('passes a request with no Origin header (a non-browser client)', async () => {
    const middleware = await load()
    expect(run(middleware, {})).toBeUndefined()
  })

  it('passes WEB_URL, APEX_URL and every CORS_ALLOWED_ORIGINS entry', async () => {
    const middleware = await load({ APEX_URL, CORS_ALLOWED_ORIGINS })
    for (const origin of [
      'https://app.example.com',
      'https://admin.example.com',
      'https://shop.example.com',
      'https://docs.example.com',
    ]) {
      expect(run(middleware, { origin, 'sec-fetch-site': 'same-origin' })).toBeUndefined()
      expect(run(middleware, { origin, 'sec-fetch-site': 'same-site' })).toBeUndefined()
      expect(run(middleware, { origin })).toBeUndefined()
    }
  })

  it('passes an unlisted origin the browser marks same-origin (a frontend served beside the API)', async () => {
    const middleware = await load()
    expect(
      run(middleware, { origin: 'http://localhost:8088', 'sec-fetch-site': 'same-origin' })
    ).toBeUndefined()
  })

  it('refuses a sibling-subdomain origin 403 ORIGIN_NOT_ALLOWED', async () => {
    const middleware = await load({ APEX_URL, CORS_ALLOWED_ORIGINS })
    const rejection = run(middleware, {
      origin: 'https://blog.example.com',
      'sec-fetch-site': 'same-site',
    })
    expect(rejection).toMatchObject({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('refuses an unlisted origin that sends no Sec-Fetch-Site, and an opaque null origin', async () => {
    const middleware = await load()
    expect(run(middleware, { origin: 'https://blog.example.com' })).toMatchObject({
      statusCode: 403,
    })
    expect(run(middleware, { origin: 'null' })).toMatchObject({ statusCode: 403 })
  })

  it('passes an opaque null origin only when the browser marks the request same-origin', async () => {
    const middleware = await load()
    expect(run(middleware, { origin: 'null', 'sec-fetch-site': 'same-origin' })).toBeUndefined()
    expect(run(middleware, { origin: 'null' })).toMatchObject({
      statusCode: 403,
      code: 'ORIGIN_NOT_ALLOWED',
    })
  })
})
