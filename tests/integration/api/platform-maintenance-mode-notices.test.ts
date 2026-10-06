/**
 * @file A change into `full` through the real app with the notification
 * and email Workers running: the notices are delivered (an in-app row and
 * a finished email) before every queue pauses, nothing is left pending,
 * and switching off resumes the queues.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { sql } from '@/services/database.service'
import { hasPendingNotices } from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { setAllQueuesPaused } from '@/services/maintenance-mode/maintenance-mode-queues.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getAllQueues } from '@/services/queue.service'
import type { PlatformMaintenanceModeView } from '@/types/maintenance-mode'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { clearMaintenanceNotices } from '../../helpers/maintenance-mode-notices'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const emailWorker = startEmailWorker()
const notificationWorker = startNotificationWorker()
const PATH = '/api/v1/platform/maintenance-mode'

/**
 * The stored version and the queues, as a client reads them.
 * @param token - A staff token.
 * @returns The view.
 */
async function view(token: string): Promise<PlatformMaintenanceModeView> {
  const response = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)
  return (response.body as { data: PlatformMaintenanceModeView }).data
}

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  await setAllQueuesPaused(false)
  await clearMaintenanceNotices()
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await sql`delete from notifications where type = 'maintenance_mode_changed'`
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await emailWorker.close()
  await notificationWorker.close()
  await Promise.all(getAllQueues().map((queue) => queue.obliterate({ force: true })))
  await closeQueue()
})

describe('entering and leaving full', () => {
  it('delivers the notices before pausing every queue, then resumes them on switching off', async () => {
    const { token } = await createTrackedStaff('owner')
    const { user: admin } = await createTrackedStaff('admin')
    const before = await view(token)

    const on = await request(app).put(PATH).set('Authorization', `Bearer ${token}`).send({
      mode: 'full',
      message: 'Down for an upgrade.',
      reason: 'Database upgrade',
      expectedVersion: before.version,
      confirm: 'local',
    })

    expect(on.status).toBe(200)
    const onView = (on.body as { data: PlatformMaintenanceModeView }).data
    expect(onView.queues.every((queue) => queue.paused === true)).toBe(true)
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from notifications
      where user_id = ${admin.id} and type = 'maintenance_mode_changed'`
    expect(row?.count).toBe(1)
    expect(await hasPendingNotices()).toBe(false)

    const off = await request(app)
      .put(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'off', expectedVersion: onView.version })

    expect(off.status).toBe(200)
    const offView = (off.body as { data: PlatformMaintenanceModeView }).data
    expect(offView.queues.every((queue) => queue.paused === false)).toBe(true)
  })

  it('pauses on an escalation from read_only too', async () => {
    const { token } = await createTrackedStaff('owner')
    await storeMaintenanceMode('read_only')
    const before = await view(token)

    const response = await request(app).put(PATH).set('Authorization', `Bearer ${token}`).send({
      mode: 'full',
      message: 'Down.',
      reason: 'Escalating',
      expectedVersion: before.version,
      confirm: 'local',
    })

    expect(response.status).toBe(200)
    const after = (response.body as { data: PlatformMaintenanceModeView }).data
    expect(after.queues.every((queue) => queue.paused === true)).toBe(true)
  })
})
