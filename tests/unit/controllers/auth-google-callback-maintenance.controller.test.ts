/**
 * @file Unit test for the Google callback when maintenance mode refuses the
 * sign-in: the browser lands on the login page with the refusal's code, and
 * nothing is logged, because the refusal is expected and its message is the
 * owner's customer text.
 */
import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'

vi.mock('@/services/verification.service', () => ({
  frontendUrl: () => 'https://app.example.com',
}))
vi.mock('passport', () => ({
  default: {
    authenticate:
      (_name: string, _options: unknown, callback: (error: unknown, profile: object) => void) =>
      () => {
        callback(undefined, { id: 'google-id' })
      },
  },
}))
vi.mock('@/services/google-auth.service', () => ({
  completeGoogleSignIn: () =>
    Promise.reject(
      new MaintenanceModeError('MAINTENANCE_MODE', {
        mode: 'full',
        message: 'Customer text that must never be logged.',
        since: '2026-10-06T10:42:00.000Z',
      })
    ),
}))

describe('handleGoogleCallback in full maintenance', () => {
  it('redirects with MAINTENANCE_MODE and logs nothing', async () => {
    const { logger } = await import('@/services/logger.service')
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { authController } = await import('@/controllers/auth.controller')
    const redirect = vi.fn()
    authController.handleGoogleCallback(
      { session: { oauthApp: 'react' } } as unknown as Request,
      { redirect } as unknown as Response,
      vi.fn() as NextFunction
    )
    await vi.waitFor(() => {
      expect(redirect).toHaveBeenCalledWith('https://app.example.com/login?error=MAINTENANCE_MODE')
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
