/**
 * @file Unit test for the Google callback's failure redirect: it targets the
 * frontend that started the sign-in, without doubled slashes.
 */
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

// frontendUrl is mocked, so this test proves only the trailing-slash stripping.
vi.mock('@/services/verification.service', () => ({
  frontendUrl: () => 'https://admin.example.com//',
}))
vi.mock('passport', () => ({
  default: {
    authenticate:
      (_name: string, _options: unknown, callback: (error: unknown, isProfile: false) => void) =>
      () => {
        callback(new Error('denied'), false)
      },
  },
}))

describe('handleGoogleCallback', () => {
  it('strips trailing slashes from the frontend URL before redirecting', async () => {
    const { authController } = await import('@/controllers/auth.controller')
    const redirect = vi.fn()
    authController.handleGoogleCallback(
      { session: { oauthApp: 'apex' } } as unknown as Request,
      { redirect } as unknown as Response,
      vi.fn() as NextFunction
    )
    await vi.waitFor(() => {
      expect(redirect).toHaveBeenCalledWith(
        'https://admin.example.com/login?error=google_auth_failed'
      )
    })
  })
})
