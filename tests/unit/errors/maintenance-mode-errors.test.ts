/**
 * @file `MaintenanceModeError`: it carries the stored message, the mode and
 * when it began, and falls back to a fixed message when none is stored.
 */
import { describe, expect, it } from 'vitest'
import {
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_MODE_RETRY_AFTER_SECONDS,
  READ_ONLY_MODE_CODE,
} from '@/constants/maintenance-mode.constants'
import { MaintenanceModeError } from '@/errors/maintenance-mode-errors'

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null for "none"
const NONE = null

describe('MaintenanceModeError', () => {
  it('carries the stored message, the mode, when it began and the retry hint', () => {
    const error = new MaintenanceModeError(READ_ONLY_MODE_CODE, {
      mode: 'read_only',
      message: 'Back at noon.',
      since: '2026-10-06T10:42:00.000Z',
    })

    expect(error).toMatchObject({
      name: 'MaintenanceModeError',
      message: 'Back at noon.',
      statusCode: 503,
      code: READ_ONLY_MODE_CODE,
      mode: 'read_only',
      since: '2026-10-06T10:42:00.000Z',
      retryAfterSeconds: MAINTENANCE_MODE_RETRY_AFTER_SECONDS,
    })
  })

  it('falls back to a fixed message when the snapshot has none', () => {
    const error = new MaintenanceModeError(MAINTENANCE_MODE_CODE, {
      mode: 'full',
      message: NONE,
      since: NONE,
    })

    expect(error.message).toBe('The service is down for maintenance. Please try again shortly.')
    expect(error.since).toBeNull()
  })
})
