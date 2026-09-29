/**
 * @file Unit tests for `rememberOAuthApp`: only an exact 'apex' or 'web' is
 * stored in the OAuth session, and anything else becomes 'web'.
 */
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { rememberOAuthApp } from '@/middlewares/oauth-app.middleware'

describe('rememberOAuthApp', () => {
  it.each([
    [{ app: 'apex' }, 'apex'],
    [{ app: 'web' }, 'web'],
    [{}, 'web'],
    [{ app: 'https://evil.example' }, 'web'],
    [{ app: 'APEX' }, 'web'],
    [{ app: ['apex', 'web'] }, 'web'],
  ])('stores %j as %s', (query, expected) => {
    const session: Record<string, unknown> = {}
    const next = vi.fn()
    rememberOAuthApp({ query, session } as unknown as Request, {} as Response, next)
    expect(session.oauthApp).toBe(expected)
    expect(next).toHaveBeenCalledWith()
  })
})
