/**
 * @file `GET` and `PUT /api/v1/platform/maintenance-mode` through the real
 * app, with no Worker running, so notice jobs stay queued to be counted:
 * the staff view, the change rules (switch-on and escalation need a reason,
 * a message and `confirm` equal to `APP_ENV`; everything else does not),
 * the version conflict, the no-op, the audit entry, who is notified, and
 * two owners saving at once. The role, step-up and OPTIONS gates are
 * `platform-route-gates.test.ts`'s; a change into `full`, which waits for
 * its notices, is `platform-maintenance-mode-notices.test.ts`'s.
 */
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import {
  queuePauseTarget,
  setAllQueuesPaused,
} from '@/services/maintenance-mode/maintenance-mode-queues.service'
import {
  getMaintenanceMode,
  reloadMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getAllQueues } from '@/services/queue.service'
import type { PlatformMaintenanceModeView } from '@/types/maintenance-mode'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import {
  clearMaintenanceNotices,
  pendingMaintenanceNotices,
} from '../../helpers/maintenance-mode-notices'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const ENVIRONMENT = 'local'
const PATH = '/api/v1/platform/maintenance-mode'
// eslint-disable-next-line unicorn/no-null -- the API's contract uses null for "none"
const NONE = null
const byText = (a: string, b: string): number => a.localeCompare(b)

/**
 * The view in a response.
 * @param response - The response.
 * @returns Its `data`.
 */
function viewOf(response: Response): PlatformMaintenanceModeView {
  return (response.body as { data: PlatformMaintenanceModeView }).data
}

/**
 * The stored version, as a client would read it.
 * @param token - A staff token.
 * @returns The version.
 */
async function currentVersion(token: string): Promise<number> {
  const response = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)
  return viewOf(response).version
}

/**
 * Send a change.
 * @param token - The caller's token.
 * @param body - The body.
 * @returns The response.
 */
function change(token: string, body: Record<string, unknown>): Promise<Response> {
  return request(app).put(PATH).set('Authorization', `Bearer ${token}`).send(body)
}

/**
 * The maintenance-mode audit entries.
 * @returns Their target and metadata.
 */
async function auditEntries(): Promise<
  { targetType: string; targetId: string; metadata: Record<string, unknown> }[]
> {
  return sql`
    select target_type as "targetType", target_id as "targetId", metadata
    from audit_logs where action = 'platform.maintenance_mode_changed'`
}

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  await clearMaintenanceNotices()
  await setAllQueuesPaused(false)
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await Promise.all(getAllQueues().map((queue) => queue.obliterate({ force: true })))
  await closeQueue()
})

describe('GET /platform/maintenance-mode', () => {
  it('answers a viewer the stored mode, the queues and the environment name', async () => {
    const { token } = await createTrackedStaff('viewer')

    const response = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(viewOf(response)).toMatchObject({
      mode: 'off',
      message: NONE,
      reason: NONE,
      since: NONE,
      changedBy: NONE,
      environment: ENVIRONMENT,
    })
    expect(viewOf(response).queues.map((queue) => queue.name)).toEqual([
      'email',
      'notification',
      'maintenance',
      'analytics',
    ])
  })
})

describe('PUT /platform/maintenance-mode', () => {
  it('switches on with a reason, a message and the environment name: audited, published, and every other owner and admin notified', async () => {
    const { user: actor, token } = await createTrackedStaff('owner', { firstName: 'Grace' })
    const { user: otherOwner } = await createTrackedStaff('owner')
    const { user: admin } = await createTrackedStaff('admin')
    await createTrackedStaff('manager')
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'read_only',
      message: 'Read only while we migrate.',
      reason: 'Data fix, ticket 77',
      expectedVersion: version,
      confirm: ENVIRONMENT,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response)).toMatchObject({
      mode: 'read_only',
      message: 'Read only while we migrate.',
      reason: 'Data fix, ticket 77',
      changedBy: { id: actor.id, name: 'Grace' },
      version: version + 1,
    })
    expect(getMaintenanceMode()).toMatchObject({ mode: 'read_only', version: version + 1 })
    const platform = await platformTenant()
    expect(await auditEntries()).toEqual([
      {
        targetType: 'platform',
        targetId: platform.id,
        metadata: {
          from: 'off',
          to: 'read_only',
          reason: 'Data fix, ticket 77',
          messageChanged: true,
        },
      },
    ])
    const notices = await pendingMaintenanceNotices()
    const recipients = notices.map((job) => job.data.userId)
    expect(recipients.toSorted(byText)).toEqual([otherOwner.id, admin.id].toSorted(byText))
  })

  it.each([
    ['missing', undefined],
    ['wrong', 'prod'],
  ])(
    'refuses a switch-on with a %s confirm 400 CONFIRMATION_MISMATCH, writing nothing',
    async (_label, confirm) => {
      const { token } = await createTrackedStaff('owner')
      const version = await currentVersion(token)

      const response = await change(token, {
        mode: 'full',
        message: 'Down.',
        reason: 'Upgrade',
        expectedVersion: version,
        ...(confirm !== undefined && { confirm }),
      })

      expect(response.status).toBe(400)
      expect((response.body as { code?: string }).code).toBe('CONFIRMATION_MISMATCH')
      expect(await currentVersion(token)).toBe(version)
      expect(await auditEntries()).toEqual([])
    }
  )

  it('refuses a switch-on without a reason or without a message, field by field', async () => {
    const { token } = await createTrackedStaff('owner')
    const version = await currentVersion(token)

    const noReason = await change(token, {
      mode: 'read_only',
      message: 'Read only.',
      expectedVersion: version,
      confirm: ENVIRONMENT,
    })
    const noMessage = await change(token, {
      mode: 'read_only',
      reason: 'Data fix',
      expectedVersion: version,
      confirm: ENVIRONMENT,
    })

    expect(noReason.status).toBe(400)
    expect(noReason.body).toMatchObject({
      message: 'Validation failed',
      errors: { reason: [expect.any(String)] },
    })
    expect(noMessage.status).toBe(400)
    expect(noMessage.body).toMatchObject({ errors: { message: [expect.any(String)] } })
  })

  it('refuses an escalation from read_only to full without the confirm', async () => {
    const { token } = await createTrackedStaff('owner')
    await storeMaintenanceMode('read_only')
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'full',
      message: 'Down.',
      reason: 'Escalating',
      expectedVersion: version,
    })

    expect((response.body as { code?: string }).code).toBe('CONFIRMATION_MISMATCH')
  })

  it('answers a stale version 409 MAINTENANCE_MODE_CONFLICT', async () => {
    const { token } = await createTrackedStaff('owner')
    const version = await currentVersion(token)

    const response = await change(token, { mode: 'off', expectedVersion: version - 1 })

    expect(response.status).toBe(409)
    expect((response.body as { code?: string }).code).toBe('MAINTENANCE_MODE_CONFLICT')
  })

  it('keeps since across a message edit: the response, the staff view, the public status, the 503 body and the pause grace', async () => {
    const { token } = await createTrackedStaff('owner')
    const began = new Date(Date.now() - 3_600_000)
    await storeMaintenanceMode('full', { message: 'Old.', changedAt: began })
    await reloadMaintenanceMode()
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'full',
      message: 'New.',
      expectedVersion: version,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response)).toMatchObject({ message: 'New.', since: began.toISOString() })
    expect(viewOf(await request(app).get(PATH).set('Authorization', `Bearer ${token}`)).since).toBe(
      began.toISOString()
    )
    const status = await request(app).get('/api/v1/status/maintenance')
    expect((status.body as { data: { since: string } }).data.since).toBe(began.toISOString())
    const refused = await request(app).get('/api/v1/tenants')
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ message: 'New.', since: began.toISOString() })
    expect(getMaintenanceMode().changedAt).toBe(began.toISOString())
    expect(queuePauseTarget(getMaintenanceMode(), new Date())).toBe('pause')
  })

  it('names a staff member with no name as "A staff member" in the notices, never by address', async () => {
    const { user: actor, token } = await createTrackedStaff('owner')
    await createTrackedStaff('admin')
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'read_only',
      message: 'Read only.',
      reason: 'Data fix',
      expectedVersion: version,
      confirm: ENVIRONMENT,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response).changedBy).toEqual({ id: actor.id, name: 'A staff member' })
    const notices = await pendingMaintenanceNotices()
    expect(notices).toHaveLength(1)
    const [notice] = notices
    expect(notice?.data.body).toContain('A staff member set maintenance mode')
    expect(JSON.stringify(notice?.data)).not.toContain(actor.email)
  })

  it('answers a no-op with the current state, writing, auditing and notifying nothing', async () => {
    const { token } = await createTrackedStaff('owner')
    await createTrackedStaff('admin')
    await storeMaintenanceMode('read_only', { message: 'Same.' })
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'read_only',
      message: 'Same.',
      expectedVersion: version,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response).version).toBe(version)
    expect(await auditEntries()).toEqual([])
    expect(await pendingMaintenanceNotices()).toEqual([])
  })

  it('edits the message with no reason or confirm, audited but not notified', async () => {
    const { token } = await createTrackedStaff('owner')
    await createTrackedStaff('admin')
    await storeMaintenanceMode('read_only', { message: 'Old.' })
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'read_only',
      message: 'New.',
      expectedVersion: version,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response).message).toBe('New.')
    const entries = await auditEntries()
    expect(entries.map((entry) => entry.metadata)).toEqual([
      { from: 'read_only', to: 'read_only', reason: NONE, messageChanged: true },
    ])
    expect(await pendingMaintenanceNotices()).toEqual([])
  })

  it('de-escalates from full with no confirm, resumes the queues, and notifies nobody', async () => {
    const { token } = await createTrackedStaff('owner')
    await createTrackedStaff('admin')
    await storeMaintenanceMode('full')
    await setAllQueuesPaused(true)
    const version = await currentVersion(token)

    const response = await change(token, {
      mode: 'read_only',
      message: 'Reads are back.',
      expectedVersion: version,
    })

    expect(response.status).toBe(200)
    expect(viewOf(response).queues.every((queue) => queue.paused === false)).toBe(true)
    expect(await pendingMaintenanceNotices()).toEqual([])
  })

  it('still needs a message for a mode that stays on', async () => {
    const { token } = await createTrackedStaff('owner')
    await storeMaintenanceMode('full')
    const version = await currentVersion(token)

    const response = await change(token, { mode: 'read_only', expectedVersion: version })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { message: [expect.any(String)] } })
  })

  it('switches off with no reason: the message is cleared and every other owner and admin is notified', async () => {
    const { token } = await createTrackedStaff('owner')
    const { user: admin } = await createTrackedStaff('admin')
    await storeMaintenanceMode('read_only')
    const version = await currentVersion(token)

    const response = await change(token, { mode: 'off', expectedVersion: version })

    expect(response.status).toBe(200)
    expect(viewOf(response)).toMatchObject({
      mode: 'off',
      message: NONE,
      since: NONE,
      reason: NONE,
    })
    const notices = await pendingMaintenanceNotices()
    expect(notices.map((job) => job.data.userId)).toEqual([admin.id])
  })

  it('lets exactly one of two owners saving at once win; the other gets 409 and nothing doubles', async () => {
    const first = await createTrackedStaff('owner')
    const second = await createTrackedStaff('owner')
    const version = await currentVersion(first.token)
    const body = {
      mode: 'read_only',
      message: 'Read only.',
      reason: 'Data fix',
      expectedVersion: version,
      confirm: ENVIRONMENT,
    }

    const responses = await Promise.all([change(first.token, body), change(second.token, body)])

    const statuses = responses.map((response) => response.status)
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409])
    expect(await auditEntries()).toHaveLength(1)
    const ours = new Set([first.user.id, second.user.id])
    const notices = await pendingMaintenanceNotices()
    expect(notices.filter((job) => ours.has(job.data.userId))).toHaveLength(1)
    expect(await currentVersion(first.token)).toBe(version + 1)
  })
})
