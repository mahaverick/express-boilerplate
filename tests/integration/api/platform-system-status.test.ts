/**
 * @file GET /api/v1/platform/system/status through the real app: an admin
 * gets the release, error tracking's status, the flags' status and the
 * maintenance section, a viewer
 * the plain 404, and no read is audited. The counters themselves are the
 * error-counters and flag-counters services'; here they are spied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import * as counters from '@/services/errors/error-counters.service'
import * as flagCounters from '@/services/flags/flag-counters.service'
import * as maintenanceMode from '@/services/maintenance-mode/maintenance-mode.service'
import type { FlagsStatus } from '@/types/flags'
import type { MaintenanceModeStatus } from '@/types/maintenance-mode'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()

/**
 * A status as the counters service could answer it.
 * @returns The status.
 */
function sampleStatus(): counters.ErrorTrackingStatus {
  return {
    enabled: true,
    window: '15m',
    sent: 42,
    dropped: { throttled: 3, buffer_full: 0, rejected: 0, retry_exhausted: 0 },
    lastSendOkAt: '2026-10-04T10:00:00.000Z',
    lastSendError: 401,
  }
}

/**
 * A flags status as the flag-counters service could answer it.
 * @returns The status.
 */
function sampleFlagsStatus(): FlagsStatus {
  return {
    enabled: true,
    snapshotAt: '2026-10-05T10:00:00.000Z',
    checkedAt: '2026-10-05T10:05:00.000Z',
    stale: false,
    lastFetchOk: '2026-10-05T10:05:00.000Z',
    // eslint-disable-next-line unicorn/no-null -- no fetch has failed
    lastFetchError: null,
    propertyMatchingVersion: 1,
    counts: {
      registered: 2,
      active: 1,
      inactive: 1,
      missing: 0,
      unsupported: 0,
      unregistered: 3,
      unknownVariant15m: 0,
    },
  }
}

/**
 * A maintenance section as the maintenance-mode service could answer it.
 * @returns The section.
 */
function sampleMaintenanceStatus(): MaintenanceModeStatus {
  return {
    mode: 'full',
    since: '2026-10-06T10:42:00.000Z',
    known: true,
    queuesPaused: true,
    queues: [{ name: 'email', paused: true, active: 0 }],
    noticesPending: false,
    // eslint-disable-next-line unicorn/no-null -- the last reload succeeded
    lastReloadError: null,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

describe('GET /platform/system/status', () => {
  it('answers an admin with the release, error tracking and flags, and audits nothing', async () => {
    vi.spyOn(counters, 'getErrorTrackingStatus').mockResolvedValue(sampleStatus())
    vi.spyOn(flagCounters, 'getFlagsStatus').mockResolvedValue(sampleFlagsStatus())
    vi.spyOn(maintenanceMode, 'getMaintenanceModeStatus').mockResolvedValue(
      sampleMaintenanceStatus()
    )
    const { user, token } = await createTrackedStaff('admin')

    const response = await request(app)
      .get('/api/v1/platform/system/status')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect((response.body as { data: unknown }).data).toEqual({
      release: 'dev',
      errorTracking: sampleStatus(),
      flags: sampleFlagsStatus(),
      maintenance: sampleMaintenanceStatus(),
    })
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_logs where actor_user_id = ${user.id}`
    expect(row?.count).toBe(0)
  })

  it('refuses a viewer with 404 without reading the counters', async () => {
    const read = vi.spyOn(counters, 'getErrorTrackingStatus')
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app)
      .get('/api/v1/platform/system/status')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })
})
