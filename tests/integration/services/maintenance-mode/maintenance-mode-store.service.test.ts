/**
 * @file The store against this worker's real `maintenance_mode_state` row
 * and Redis: the seeded row, its CHECKs, the compare-and-set update, the
 * actor's purge, a change reaching two independent stores through pub/sub,
 * the backstop picking up an unpublished change, and a stopped store
 * staying stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readMaintenanceModeState,
  updateMaintenanceModeStateIfVersion,
} from '@/repositories/maintenance-mode.repository'
import { sql, withTransaction } from '@/services/database.service'
import {
  createMaintenanceModeStore,
  publishMaintenanceModeChange,
  type MaintenanceModeStore,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'
import { waitUntil } from '../../../helpers/timing'

const stores: MaintenanceModeStore[] = []

/**
 * A started store, stopped after the test.
 * @param reloadIntervalMs - Its backstop interval.
 * @returns The store.
 */
async function startedStore(reloadIntervalMs = 60_000): Promise<MaintenanceModeStore> {
  const store = createMaintenanceModeStore({ reloadIntervalMs })
  stores.push(store)
  await store.start()
  return store
}

beforeEach(async () => {
  await resetMaintenanceMode()
})

afterEach(async () => {
  await Promise.all(stores.map((store) => store.stop()))
  stores.length = 0
  await resetMaintenanceMode()
  await deleteTrackedUsers()
})

describe('maintenance_mode_state', () => {
  it('holds exactly one row, which migration 0024 seeded', async () => {
    const rows = await sql<{ id: number }[]>`select id from maintenance_mode_state`
    expect(rows).toEqual([{ id: 1 }])
  })

  it('refuses a second row, an unknown mode, a mode that is on without a message, and a long message', async () => {
    await expect(
      sql`insert into maintenance_mode_state (id, mode, changed_at, version) values (2, 'off', now(), 0)`
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      sql`update maintenance_mode_state set mode = 'partial' where id = 1`
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      sql`update maintenance_mode_state set mode = 'full', message = null where id = 1`
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      sql`update maintenance_mode_state set mode = 'full', message = ${'x'.repeat(501)} where id = 1`
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('updates only when the version still matches, and increments it', async () => {
    const actor = await createTrackedUser()
    const before = await readMaintenanceModeState()
    const change = {
      mode: 'read_only',
      message: 'Read only.',
      reason: 'DB work',
      changedBy: actor.id,
    } as const

    const stale = await withTransaction((tx) =>
      updateMaintenanceModeStateIfVersion(change, before.version - 1, tx)
    )
    const fresh = await withTransaction((tx) =>
      updateMaintenanceModeStateIfVersion(change, before.version, tx)
    )

    expect(stale).toBeUndefined()
    expect(fresh).toMatchObject({ ...change, version: before.version + 1 })
  })

  it('sets changed_by to null when the user who made the change is deleted', async () => {
    const actor = await createTrackedUser()
    const { version } = await readMaintenanceModeState()
    await withTransaction((tx) =>
      updateMaintenanceModeStateIfVersion(
        { mode: 'read_only', message: 'Read only.', reason: 'DB work', changedBy: actor.id },
        version,
        tx
      )
    )

    await deleteTrackedUsers()

    const after = await readMaintenanceModeState()
    expect(after.changedBy).toBeNull()
  })
})

describe('maintenance-mode store', () => {
  it('loads the stored row at start', async () => {
    await storeMaintenanceMode('read_only', { message: 'Read only for a while.' })

    const store = await startedStore()

    expect(store.get()).toMatchObject({
      mode: 'read_only',
      message: 'Read only for a while.',
      known: true,
    })
  })

  it('reloads every store when a change is published', async () => {
    const first = await startedStore()
    const second = await startedStore()

    const version = await storeMaintenanceMode('full', { message: 'Upgrading.' })
    await publishMaintenanceModeChange()

    await waitUntil(() => first.get().version === version && second.get().version === version, {
      message: 'both stores reloaded on the published change',
    })
    expect(first.get()).toMatchObject({ mode: 'full', message: 'Upgrading.' })
    expect(second.get()).toMatchObject({ mode: 'full', message: 'Upgrading.' })
  })

  it('picks up an unpublished change on the backstop', async () => {
    const store = await startedStore(50)

    const version = await storeMaintenanceMode('read_only')

    await waitUntil(() => store.get().version === version, {
      message: 'the backstop reloaded the unpublished change',
    })
    expect(store.get().mode).toBe('read_only')
  })

  it('stops reloading once stopped', async () => {
    const store = await startedStore(50)
    const before = store.get()
    await store.stop()

    await storeMaintenanceMode('full')
    await store.reload()

    expect(store.get()).toBe(before)
  })
})
