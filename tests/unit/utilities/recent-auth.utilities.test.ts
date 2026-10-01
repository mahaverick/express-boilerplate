/**
 * @file `isRecentAuth`: seconds in (`auth_time`), milliseconds `now`, the
 * same arithmetic `requireRecentAuth` applied before it moved here.
 */
import { describe, expect, it } from 'vitest'
import { STEP_UP_MAX_AGE_MS } from '@/constants/auth.constants'
import { isRecentAuth } from '@/utilities/recent-auth.utilities'

const NOW_MS = Date.parse('2026-09-30T12:00:00.000Z')
const nowSeconds = NOW_MS / 1000

describe('isRecentAuth', () => {
  it('accepts a sign-in this instant and one exactly at the window edge', () => {
    expect(isRecentAuth(nowSeconds, NOW_MS)).toBe(true)
    expect(isRecentAuth(nowSeconds - STEP_UP_MAX_AGE_MS / 1000, NOW_MS)).toBe(true)
  })

  it('refuses a sign-in one second past the window', () => {
    expect(isRecentAuth(nowSeconds - STEP_UP_MAX_AGE_MS / 1000 - 1, NOW_MS)).toBe(false)
  })

  it('refuses a token with no auth_time', () => {
    expect(isRecentAuth(undefined, NOW_MS)).toBe(false)
  })

  it('honours a custom window', () => {
    expect(isRecentAuth(nowSeconds - 30, NOW_MS, 60_000)).toBe(true)
    expect(isRecentAuth(nowSeconds - 90, NOW_MS, 60_000)).toBe(false)
  })
})
