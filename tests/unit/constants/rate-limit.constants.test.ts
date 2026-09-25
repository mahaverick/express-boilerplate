// tests/unit/constants/rate-limit.constants.test.ts
//
// Pins two things a refactor could silently break: (1) every limiter's
// Redis key PREFIX (the `name` field — a live counter's key depends on it,
// so changing one resets production counters on deploy) stays exactly the
// 19 strings and the exact order tests/unit/middlewares/rate-limit.middleware.test.ts's
// `store prefixes` describe block pinned against the pre-refactor factories;
// (2) the three key-DERIVATION functions produce byte-identical output for
// a fixed input, so a caller mid-window (Redis already holding counts keyed
// by the old function's output) is not silently split onto a new bucket.
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import {
  authenticatedUserRateLimitKey,
  RATE_LIMITS,
  submittedEmailRateLimitKey,
} from '@/constants/rate-limit.constants'

const EXPECTED_NAMES_IN_ORDER = [
  'register',
  'login',
  'login-ip',
  'login-account',
  'refresh',
  'logout',
  'verify-email',
  'resend-verification-ip',
  'resend-verification-email',
  'forgot-password-ip',
  'forgot-password-email',
  'reset-password',
  'google-oauth',
  'google-oauth-callback',
  'create-tenant',
  'invite-tenant-member',
  'change-password',
  'invitation-preview',
  'invitation-accept',
]

describe('RATE_LIMITS key stability', () => {
  it("keeps every limiter's Redis key prefix identical to the pre-refactor factories, in the same order", () => {
    expect(Object.values(RATE_LIMITS).map((spec) => spec.name)).toEqual(EXPECTED_NAMES_IN_ORDER)
  })

  it('never reuses a name across two limiters', () => {
    const names = Object.values(RATE_LIMITS).map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('derives the same composite key for login: ip + ":" + normalised email', () => {
    const request = {
      ip: '203.0.113.5',
      body: { email: 'Victim@Example.com' },
    } as unknown as Request
    const keyBy = RATE_LIMITS.login.keyBy
    if (typeof keyBy !== 'function') throw new Error('login.keyBy must be a function')
    expect(keyBy(request)).toBe('203.0.113.5:victim@example.com')
  })

  it('derives the same email-only key: the normalised submitted email, ip ignored', () => {
    const request = { body: { email: 'Victim@Example.com' } } as unknown as Request
    expect(submittedEmailRateLimitKey(request)).toBe('victim@example.com')
  })

  it('derives the same user key: request.user.id, or "anonymous" when unset', () => {
    const withUser = { user: { id: 'user-123' } } as unknown as Request
    const withoutUser = {} as unknown as Request
    expect(authenticatedUserRateLimitKey(withUser)).toBe('user-123')
    expect(authenticatedUserRateLimitKey(withoutUser)).toBe('anonymous')
  })
})
