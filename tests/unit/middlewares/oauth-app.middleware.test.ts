import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { oauthAppOf, rememberOAuthApp } from '@/middlewares/oauth-app.middleware'

function fakeRequest(query: Record<string, unknown>, session: Record<string, unknown> = {}) {
  return { query, session } as unknown as Request
}

describe('rememberOAuthApp', () => {
  it.each([
    [{ app: 'apex' }, 'apex'],
    [{ app: 'web' }, 'web'],
    [{}, 'web'],
    [{ app: 'https://evil.example' }, 'web'],
    [{ app: 'APEX' }, 'web'],
    [{ app: ['apex', 'web'] }, 'web'],
  ])('stores %j as %s', (query, expected) => {
    const request = fakeRequest(query)
    const next = vi.fn()
    rememberOAuthApp(request, {} as Response, next)
    expect(oauthAppOf(request)).toBe(expected)
    expect(next).toHaveBeenCalledWith()
  })
})

describe('oauthAppOf', () => {
  it('answers web when there is no session', () => {
    expect(oauthAppOf({} as Request)).toBe('web')
  })

  it('answers web for a tampered session value', () => {
    expect(oauthAppOf(fakeRequest({}, { oauthApp: 'https://evil.example' }))).toBe('web')
  })
})
