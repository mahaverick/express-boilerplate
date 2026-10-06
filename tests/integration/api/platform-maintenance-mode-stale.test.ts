/**
 * @file Two owners changing the mode while the first waits for its notices
 * before pausing: the first must not pause the queues of a mode the second
 * already left, and its notice wait ends by the pause grace.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import { MAINTENANCE_MODE_PAUSE_GRACE_MS } from '@/constants/maintenance-mode.constants'
import * as notices from '@/services/maintenance-mode/maintenance-mode-notices.service'
import { setAllQueuesPaused } from '@/services/maintenance-mode/maintenance-mode-queues.service'
import * as store from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  getMaintenanceMode,
  reloadMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getAllQueues } from '@/services/queue.service'
import type { PlatformMaintenanceModeView } from '@/types/maintenance-mode'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode } from '../../helpers/maintenance-mode'
import { clearMaintenanceNotices } from '../../helpers/maintenance-mode-notices'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { waitUntil } from '../../helpers/timing'

const app = createApp()
const PATH = '/api/v1/platform/maintenance-mode'

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  vi.restoreAllMocks()
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

describe('a change that waits for its notices', () => {
  it('does not pause the queues when another change left full during the wait', async () => {
    const first = await createTrackedStaff('owner')
    const second = await createTrackedStaff('owner')
    const before = await request(app).get(PATH).set('Authorization', `Bearer ${first.token}`)
    const version = (before.body as { data: PlatformMaintenanceModeView }).data.version
    let releaseWait!: (outcome: 'done') => void
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
    const held = new Promise<'done'>((resolve) => {
      releaseWait = resolve
    })
    const wait = vi.spyOn(notices, 'waitForNoticeJobs').mockImplementation(() => held)

    // A supertest request is lazy: awaiting it inside an async function is what sends it now.
    const pending = (async () =>
      request(app).put(PATH).set('Authorization', `Bearer ${first.token}`).send({
        mode: 'full',
        message: 'Down.',
        reason: 'Upgrade',
        expectedVersion: version,
        confirm: 'local',
      }))()
    await waitUntil(() => wait.mock.calls.length === 1, { message: 'the first change is waiting' })
    const leaving = await request(app)
      .put(PATH)
      .set('Authorization', `Bearer ${second.token}`)
      .send({ mode: 'off', expectedVersion: version + 1 })
    expect(leaving.status).toBe(200)
    expect(getMaintenanceMode().mode).toBe('off')
    releaseWait('done')
    const response = await pending

    expect(response.status).toBe(200)
    const flags = await Promise.all(getAllQueues().map((queue) => queue.isPaused()))
    expect(flags).toEqual([false, false, false, false])
  })

  it('still pauses the queues when another owner only edited the message during the wait', async () => {
    const first = await createTrackedStaff('owner')
    const second = await createTrackedStaff('owner')
    const before = await request(app).get(PATH).set('Authorization', `Bearer ${first.token}`)
    const version = (before.body as { data: PlatformMaintenanceModeView }).data.version
    let releaseWait!: (outcome: 'done') => void
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- tsconfig.json pins `lib: ["ES2023"]`; `Promise.withResolvers` is ES2024 and untyped under it.
    const held = new Promise<'done'>((resolve) => {
      releaseWait = resolve
    })
    const wait = vi.spyOn(notices, 'waitForNoticeJobs').mockImplementation(() => held)

    // A supertest request is lazy: awaiting it inside an async function is what sends it now.
    const pending = (async () =>
      request(app).put(PATH).set('Authorization', `Bearer ${first.token}`).send({
        mode: 'full',
        message: 'Down.',
        reason: 'Upgrade',
        expectedVersion: version,
        confirm: 'local',
      }))()
    await waitUntil(() => wait.mock.calls.length === 1, { message: 'the first change is waiting' })
    const edit = await request(app)
      .put(PATH)
      .set('Authorization', `Bearer ${second.token}`)
      .send({ mode: 'full', message: 'Down until noon.', expectedVersion: version + 1 })
    expect(edit.status).toBe(200)
    expect(getMaintenanceMode()).toMatchObject({ mode: 'full', version: version + 2 })
    releaseWait('done')
    const response = await pending

    expect(response.status).toBe(200)
    const flags = await Promise.all(getAllQueues().map((queue) => queue.isPaused()))
    expect(flags).toEqual([true, true, true, true])
  })

  it('still pauses the queues when this replica’s reload failed and its store is behind', async () => {
    const { token } = await createTrackedStaff('owner')
    const before = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)
    const version = (before.body as { data: PlatformMaintenanceModeView }).data.version
    vi.spyOn(notices, 'waitForNoticeJobs').mockResolvedValue('done')
    vi.spyOn(store, 'reloadMaintenanceMode').mockResolvedValue()

    const response = await request(app).put(PATH).set('Authorization', `Bearer ${token}`).send({
      mode: 'full',
      message: 'Down.',
      reason: 'Upgrade',
      expectedVersion: version,
      confirm: 'local',
    })

    expect(response.status).toBe(200)
    expect(getMaintenanceMode().version).toBeLessThan(version + 1)
    const flags = await Promise.all(getAllQueues().map((queue) => queue.isPaused()))
    expect(flags).toEqual([true, true, true, true])
  })

  it('is given what is left of the notice wait after the commit, never more than all of it', async () => {
    const { token } = await createTrackedStaff('owner')
    const before = await request(app).get(PATH).set('Authorization', `Bearer ${token}`)
    const version = (before.body as { data: PlatformMaintenanceModeView }).data.version
    const wait = vi.spyOn(notices, 'waitForNoticeJobs').mockResolvedValue('done')

    await request(app).put(PATH).set('Authorization', `Bearer ${token}`).send({
      mode: 'full',
      message: 'Down.',
      reason: 'Upgrade',
      expectedVersion: version,
      confirm: 'local',
    })

    const budget = wait.mock.calls[0]?.[1]
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(MAINTENANCE_MODE_PAUSE_GRACE_MS)
  })
})
