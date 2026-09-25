// tests/unit/constants/rate-limit.constants.test.ts
//
// Pins three things a refactor could silently break: (1) every limiter's
// Redis key PREFIX (the `name` field — a live counter's key depends on it,
// so changing one resets production counters on deploy) stays exactly the
// 20 literal strings, in order; (2) every entry's `windowMs`, `limit` and
// `keyBy` kind match today's literal values, so a budget or key-axis drift
// is caught even though it changes no Redis key; (3) the three
// key-DERIVATION functions produce byte-identical output for a fixed
// input, so a caller mid-window (Redis already holding counts keyed by the
// old function's output) is not silently split onto a new bucket.
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import {
  authenticatedUserRateLimitKey,
  RATE_LIMITS,
  submittedEmailRateLimitKey,
  type RateLimitName,
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
  'platform-search',
]

// The full table, literal per field, independent of RATE_LIMITS's own
// values — no `60 * 60 * 1000`, no reading a sibling entry. This is what
// catches a windowMs/limit/keyBy drift the name-stability test above
// can't see: that test only pins `name` (the Redis key), not the budget or
// the key axis enforcing it.
const EXPECTED_RATE_LIMITS: {
  key: RateLimitName
  name: string
  windowMs: number
  limit: number
  keyBy: 'ip' | 'user' | 'email' | 'function'
}[] = [
  { key: 'register', name: 'register', windowMs: 3_600_000, limit: 100, keyBy: 'ip' },
  { key: 'login', name: 'login', windowMs: 900_000, limit: 5, keyBy: 'function' },
  { key: 'loginIp', name: 'login-ip', windowMs: 900_000, limit: 100, keyBy: 'ip' },
  { key: 'loginAccount', name: 'login-account', windowMs: 3_600_000, limit: 100, keyBy: 'email' },
  { key: 'refresh', name: 'refresh', windowMs: 300_000, limit: 300, keyBy: 'ip' },
  { key: 'logout', name: 'logout', windowMs: 300_000, limit: 300, keyBy: 'ip' },
  { key: 'verifyEmail', name: 'verify-email', windowMs: 900_000, limit: 30, keyBy: 'ip' },
  {
    key: 'resendVerificationIp',
    name: 'resend-verification-ip',
    windowMs: 3_600_000,
    limit: 5,
    keyBy: 'ip',
  },
  {
    key: 'resendVerificationEmail',
    name: 'resend-verification-email',
    windowMs: 3_600_000,
    limit: 20,
    keyBy: 'email',
  },
  {
    key: 'forgotPasswordIp',
    name: 'forgot-password-ip',
    windowMs: 3_600_000,
    limit: 5,
    keyBy: 'ip',
  },
  {
    key: 'forgotPasswordEmail',
    name: 'forgot-password-email',
    windowMs: 3_600_000,
    limit: 20,
    keyBy: 'email',
  },
  { key: 'resetPassword', name: 'reset-password', windowMs: 900_000, limit: 10, keyBy: 'ip' },
  { key: 'googleOAuth', name: 'google-oauth', windowMs: 300_000, limit: 300, keyBy: 'ip' },
  {
    key: 'googleOAuthCallback',
    name: 'google-oauth-callback',
    windowMs: 300_000,
    limit: 300,
    keyBy: 'ip',
  },
  { key: 'createTenant', name: 'create-tenant', windowMs: 3_600_000, limit: 20, keyBy: 'user' },
  {
    key: 'inviteTenantMember',
    name: 'invite-tenant-member',
    windowMs: 3_600_000,
    limit: 30,
    keyBy: 'user',
  },
  { key: 'changePassword', name: 'change-password', windowMs: 900_000, limit: 5, keyBy: 'user' },
  {
    key: 'invitationPreview',
    name: 'invitation-preview',
    windowMs: 900_000,
    limit: 60,
    keyBy: 'ip',
  },
  {
    key: 'invitationAccept',
    name: 'invitation-accept',
    windowMs: 900_000,
    limit: 20,
    keyBy: 'ip',
  },
  { key: 'platformSearch', name: 'platform-search', windowMs: 60_000, limit: 60, keyBy: 'user' },
]

describe('RATE_LIMITS key stability', () => {
  it("keeps every limiter's Redis key prefix identical to the pre-refactor factories, in the same order", () => {
    expect(Object.values(RATE_LIMITS).map((spec) => spec.name)).toEqual(EXPECTED_NAMES_IN_ORDER)
  })

  it('never reuses a name across two limiters', () => {
    const names = Object.values(RATE_LIMITS).map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(EXPECTED_RATE_LIMITS)(
    'pins $key to { name: $name, windowMs: $windowMs, limit: $limit, keyBy: $keyBy }',
    ({ key, name, windowMs, limit, keyBy }) => {
      const actual = RATE_LIMITS[key]
      expect(actual.name).toBe(name)
      expect(actual.windowMs).toBe(windowMs)
      expect(actual.limit).toBe(limit)
      expect(typeof actual.keyBy === 'function' ? 'function' : actual.keyBy).toBe(keyBy)
    }
  )

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
