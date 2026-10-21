/**
 * @file Unit tests for `rememberOAuthApp`: the OAuth session holds a sign-in
 * intent naming the frontend, where only an exact 'apex' or 'web' is kept
 * and anything else becomes 'web', and a redirect only when it is a path on
 * that frontend's own origin.
 */
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vite-plus/test'
import { rememberOAuthApp } from '@/middlewares/oauth-app.middleware'

/**
 * Run the middleware on a request carrying `query`.
 * @param query - The parsed query string.
 * @returns The stored intent.
 */
function intentFor(query: Record<string, unknown>): unknown {
  const session: Record<string, unknown> = {}
  const next = vi.fn()
  rememberOAuthApp({ query, session } as unknown as Request, {} as Response, next)
  expect(next).toHaveBeenCalledWith()
  return session.oauthIntent
}

describe('rememberOAuthApp', () => {
  it.each([
    [{ app: 'apex' }, 'apex'],
    [{ app: 'web' }, 'web'],
    [{}, 'web'],
    [{ app: 'https://evil.example' }, 'web'],
    [{ app: 'APEX' }, 'web'],
    [{ app: ['apex', 'web'] }, 'web'],
  ])('stores %j as a sign-in to %s', (query, expected) => {
    expect(intentFor(query)).toEqual({ kind: 'sign_in', app: expected })
  })

  it('stores a same-origin redirect byte for byte', () => {
    expect(intentFor({ app: 'apex', redirect: '/tenants/acme?tenant=acme#x' })).toEqual({
      kind: 'sign_in',
      app: 'apex',
      redirect: '/tenants/acme?tenant=acme#x',
    })
  })

  it.each([
    '//evil.test',
    String.raw`/\evil.test`,
    'https://evil.test',
    'javascript:alert(1)',
    '/a\nb',
    ['/a', '/b'],
  ])('drops the redirect %j', (redirect) => {
    expect(intentFor({ redirect })).toEqual({ kind: 'sign_in', app: 'web' })
  })
})
