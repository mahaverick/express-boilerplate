/**
 * @file Unit tests for where the refresh token travels: a cookie for a
 * browser, the request and response body for a native app.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import express, { type Request, type Response } from 'express'
import { describe, expect, it } from 'vite-plus/test'
import { getEnv } from '@/configs/env.config'
import {
  clearPresentedRefreshToken,
  currentRefreshCookie,
  deliverRefreshToken,
  presentedRefreshToken,
} from '@/controllers/helpers.controller'

const BODY_TOKEN = 'a'.repeat(64)
const COOKIE_TOKEN = 'b'.repeat(64)

/**
 * A request of the given kind, with an optional body and refresh cookie.
 */
function requestOf(
  kind: 'web' | 'native',
  options: { body?: unknown; cookie?: string } = {}
): Request {
  const request = new IncomingMessage(new Socket()) as Request
  request.clientKind = kind
  request.body = options.body
  if (options.cookie !== undefined) {
    request.headers.cookie = `${currentRefreshCookie(getEnv()).name}=${options.cookie}`
  }
  return request
}

/**
 * A real Express response, so `cookie` and `clearCookie` write real headers.
 */
function responseFor(request: Request): Response {
  const response = new ServerResponse(request) as Response
  Object.setPrototypeOf(response, express.response)
  response.req = request
  response.app = express()
  return response
}

describe('presentedRefreshToken', () => {
  it('reads the body on native and ignores a cookie', () => {
    const request = requestOf('native', {
      body: { refreshToken: BODY_TOKEN },
      cookie: COOKIE_TOKEN,
    })
    expect(presentedRefreshToken(request)).toBe(BODY_TOKEN)
  })

  it('reads no cookie on native when the body has no token', () => {
    expect(presentedRefreshToken(requestOf('native', { cookie: COOKIE_TOKEN }))).toBeUndefined()
  })

  it('ignores a non-string body token on native', () => {
    expect(
      presentedRefreshToken(requestOf('native', { body: { refreshToken: 7 } }))
    ).toBeUndefined()
  })

  it('reads the cookie on web', () => {
    const request = requestOf('web', { cookie: COOKIE_TOKEN })
    expect(presentedRefreshToken(request)).toBe(COOKIE_TOKEN)
  })

  it('ignores a body token on web', () => {
    expect(presentedRefreshToken(requestOf('web', { body: { refreshToken: BODY_TOKEN } }))).toBe(
      undefined
    )
  })
})

describe('deliverRefreshToken', () => {
  const token = { raw: BODY_TOKEN, expiresAt: new Date('2026-12-01T00:00:00.000Z') }

  it('sets no Set-Cookie on native and returns both fields', () => {
    const request = requestOf('native')
    const response = responseFor(request)
    expect(deliverRefreshToken(request, response, token)).toEqual({
      refreshToken: BODY_TOKEN,
      refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z',
    })
    expect(response.getHeader('set-cookie')).toBeUndefined()
  })

  it('sets the cookie on web and returns an empty object', () => {
    const request = requestOf('web')
    const response = responseFor(request)
    expect(deliverRefreshToken(request, response, token)).toEqual({})
    expect(String(response.getHeader('set-cookie'))).toContain(`=${BODY_TOKEN}`)
  })

  it('passes the SameSite attribute through on web', () => {
    const request = requestOf('web')
    const response = responseFor(request)
    deliverRefreshToken(request, response, token, 'lax')
    expect(String(response.getHeader('set-cookie'))).toContain('SameSite=Lax')
  })
})

describe('clearPresentedRefreshToken', () => {
  it('clears nothing on native', () => {
    const request = requestOf('native')
    const response = responseFor(request)
    clearPresentedRefreshToken(request, response)
    expect(response.getHeader('set-cookie')).toBeUndefined()
  })

  it('clears the cookie on web', () => {
    const request = requestOf('web')
    const response = responseFor(request)
    clearPresentedRefreshToken(request, response)
    expect(String(response.getHeader('set-cookie'))).toContain('Expires=Thu, 01 Jan 1970')
  })
})
