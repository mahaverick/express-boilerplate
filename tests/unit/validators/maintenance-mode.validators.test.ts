/**
 * @file The change body's shape: strict, trimmed multi-line text of 1 to 500
 * characters, a non-negative integer version, and a bounded confirm. Which
 * fields a change needs is the service's rule, not this schema's.
 */
import { describe, expect, it } from 'vitest'
import { changeMaintenanceModeBody } from '@/validators/maintenance-mode.validators'

// eslint-disable-next-line unicorn/no-null -- the API's contract uses null for "clear"
const NONE = null

describe('changeMaintenanceModeBody', () => {
  it('accepts a switch-on body and trims the text, keeping newlines', () => {
    const parsed = changeMaintenanceModeBody.parse({
      mode: 'full',
      message: '  Back at noon.\r\nThanks.  ',
      reason: ' DB upgrade ',
      expectedVersion: 4,
      confirm: 'prod',
    })

    expect(parsed).toEqual({
      mode: 'full',
      message: 'Back at noon.\nThanks.',
      reason: 'DB upgrade',
      expectedVersion: 4,
      confirm: 'prod',
    })
  })

  it('accepts a bare switch-off', () => {
    expect(changeMaintenanceModeBody.parse({ mode: 'off', expectedVersion: 0 })).toEqual({
      mode: 'off',
      expectedVersion: 0,
    })
  })

  it('keeps a null reason as null and an absent one absent', () => {
    const cleared = changeMaintenanceModeBody.parse({
      mode: 'full',
      reason: NONE,
      expectedVersion: 0,
    })
    const absent = changeMaintenanceModeBody.parse({ mode: 'full', expectedVersion: 0 })

    expect(cleared.reason).toBeNull()
    expect('reason' in absent).toBe(false)
  })

  it.each([
    ['an unknown mode', { mode: 'partial', expectedVersion: 0 }],
    ['an extra field', { mode: 'off', expectedVersion: 0, changedBy: 'someone' }],
    ['a blank message', { mode: 'full', message: ' '.repeat(3), expectedVersion: 0 }],
    ['a 501-character reason', { mode: 'full', reason: 'x'.repeat(501), expectedVersion: 0 }],
    ['a bidi override', { mode: 'full', message: 'Back ‮soon', expectedVersion: 0 }],
    ['a negative version', { mode: 'off', expectedVersion: -1 }],
    ['a fractional version', { mode: 'off', expectedVersion: 1.5 }],
    ['no version', { mode: 'off' }],
    ['an oversized confirm', { mode: 'off', expectedVersion: 0, confirm: 'x'.repeat(33) }],
  ])('refuses %s', (_label, body) => {
    expect(changeMaintenanceModeBody.safeParse(body).success).toBe(false)
  })

  it('accepts exactly 500 characters', () => {
    const body = { mode: 'full', message: 'x'.repeat(500), expectedVersion: 0 }
    expect(changeMaintenanceModeBody.safeParse(body).success).toBe(true)
  })
})
