/**
 * @file `requireRecentAuth` alone: a hand-built request carrying what
 * `requireAuth` would have set, no database, no token.
 */
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { REAUTH_REQUIRED_CODE, STEP_UP_MAX_AGE_MS } from '@/constants/auth.constants'
import { HttpError } from '@/errors/http-error'
import { requireRecentAuth } from '@/middlewares/auth.middleware'

const noResponse = {} as Response

/**
 * A request as `requireAuth` leaves it.
 * @param authTime - The `auth_time` claim in seconds, or undefined for a token without one.
 * @param isSignedIn - Whether `request.user` is set.
 * @returns The request.
 */
function buildRequest(authTime: number | undefined, isSignedIn = true): Request {
  return {
    ...(isSignedIn && { user: { id: 'user-1' } }),
    ...(authTime !== undefined && { authTime }),
  } as unknown as Request
}

/**
 * Run the middleware once and return what it passed to `next`.
 * @param request - The request.
 * @param maxAgeMs - Passed to requireRecentAuth when given.
 * @returns The argument `next` received: undefined when the request was admitted.
 */
function run(request: Request, maxAgeMs?: number): unknown {
  const next = vi.fn<(error?: unknown) => void>()
  const middleware = maxAgeMs === undefined ? requireRecentAuth() : requireRecentAuth(maxAgeMs)
  middleware(request, noResponse, next as NextFunction)
  expect(next).toHaveBeenCalledTimes(1)
  return next.mock.calls[0]?.[0]
}

const secondsAgo = (seconds: number): number => Math.floor(Date.now() / 1000) - seconds

describe('requireRecentAuth', () => {
  it('pins the step-up window at 10 minutes', () => {
    expect(STEP_UP_MAX_AGE_MS).toBe(600_000)
    expect(REAUTH_REQUIRED_CODE).toBe('REAUTH_REQUIRED')
  })

  it('admits a session that authenticated just now', () => {
    const request = buildRequest(secondsAgo(0))
    expect(run(request)).toBeUndefined()
  })

  it('admits a session that authenticated 9 minutes ago', () => {
    const request = buildRequest(secondsAgo(9 * 60))
    expect(run(request)).toBeUndefined()
  })

  it.each([
    ['11 minutes ago', secondsAgo(11 * 60)],
    ['a day ago', secondsAgo(24 * 60 * 60)],
  ])('refuses a session that authenticated %s with 401 REAUTH_REQUIRED', (_label, authTime) => {
    const error = run(buildRequest(authTime))
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).code).toBe(REAUTH_REQUIRED_CODE)
  })

  it('treats a token with no auth_time (a session before migration 0018) as stale', () => {
    const error = run(buildRequest(undefined))
    expect((error as HttpError).code).toBe(REAUTH_REQUIRED_CODE)
  })

  it('honours a custom window', () => {
    const stale = buildRequest(secondsAgo(90))
    const fresh = buildRequest(secondsAgo(30))
    expect(run(stale, 60_000)).toBeInstanceOf(HttpError)
    expect(run(fresh, 60_000)).toBeUndefined()
  })

  it('refuses a request requireAuth never admitted, without the step-up code', () => {
    const error = run(buildRequest(secondsAgo(0), false))
    expect((error as HttpError).statusCode).toBe(401)
    expect((error as HttpError).code).toBeUndefined()
  })
})
