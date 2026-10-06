/**
 * @file The store's rules with an injected row reader, no database or
 * Redis: the version rule, the open start on a failed first read, the last
 * known mode on a later failure, the reload listeners, and the snapshot of
 * a row. Pub/sub, the backstop and a Redis outage are the integration tests'.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaintenanceMode } from '@/constants/maintenance-mode.constants'
import type { MaintenanceModeStateRow } from '@/database/models/maintenance-mode-state.model'
import { logger } from '@/services/logger.service'
import {
  createMaintenanceModeStore,
  snapshotOf,
  type MaintenanceModeStore,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'

const CHANGED_AT = new Date('2026-10-06T10:42:00.000Z')
// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null for "none"
const NONE = null

/**
 * A stored row.
 * @param mode - Its mode.
 * @param version - Its version.
 * @returns The row.
 */
function row(mode: MaintenanceMode, version: number): MaintenanceModeStateRow {
  return {
    id: 1,
    mode,
    // eslint-disable-next-line unicorn/no-null -- the column is null while off
    message: mode === 'off' ? null : `message v${String(version)}`,
    // eslint-disable-next-line unicorn/no-null -- no reason given
    reason: null,
    changedBy: 'user-1',
    changedAt: CHANGED_AT,
    version,
  }
}

/**
 * A store whose reads answer from `reads`, in order; an Error entry rejects.
 * @param reads - What each read answers.
 * @returns The store, not started.
 */
function storeReading(reads: (MaintenanceModeStateRow | Error)[]): MaintenanceModeStore {
  const queue = [...reads]
  return createMaintenanceModeStore({
    read: () => {
      const next = queue.shift()
      if (next === undefined) return Promise.reject(new Error('no more reads scripted'))
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('snapshotOf', () => {
  it('reports a mode that is on with its message and since', () => {
    expect(snapshotOf(row('full', 3))).toEqual({
      mode: 'full',
      message: 'message v3',
      since: '2026-10-06T10:42:00.000Z',
      changedAt: '2026-10-06T10:42:00.000Z',
      version: 3,
      known: true,
    })
  })

  it('reports off with no message and no since, but keeps changedAt', () => {
    expect(snapshotOf({ ...row('off', 4), message: 'stale text' })).toEqual({
      mode: 'off',
      message: NONE,
      since: NONE,
      changedAt: '2026-10-06T10:42:00.000Z',
      version: 4,
      known: true,
    })
  })
})

describe('maintenance-mode store rules', () => {
  it('serves off and unknown before any read', () => {
    const store = storeReading([])

    expect(store.get()).toMatchObject({ mode: 'off', known: false, message: NONE, since: NONE })
  })

  it('applies a higher version and ignores an equal or lower one', async () => {
    const store = storeReading([
      row('read_only', 5),
      row('full', 4),
      row('full', 5),
      row('full', 6),
    ])

    await store.reload()
    expect(store.get()).toMatchObject({ mode: 'read_only', version: 5 })
    await store.reload()
    expect(store.get()).toMatchObject({ mode: 'read_only', version: 5 })
    await store.reload()
    expect(store.get()).toMatchObject({ mode: 'read_only', version: 5 })
    await store.reload()
    expect(store.get()).toMatchObject({ mode: 'full', version: 6 })
  })

  it('starts open and unknown when the first read fails, logging at error once', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const store = storeReading([refused, refused])

    await store.reload()
    await store.reload()

    expect(store.get()).toMatchObject({ mode: 'off', known: false })
    expect(store.lastReloadError()).toBe('ECONNREFUSED')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      'Maintenance mode could not be read; serving off until it can',
      expect.any(Object)
    )
  })

  it('applies the first successful read after an unknown start, whatever its version', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = storeReading([new Error('down'), row('full', 0)])

    await store.reload()
    await store.reload()

    expect(store.get()).toMatchObject({ mode: 'full', version: 0, known: true })
    expect(store.lastReloadError()).toBeNull()
  })

  it('keeps the last known mode when a later read fails, warning once per failing streak', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = storeReading([
      row('full', 2),
      new Error('down'),
      new Error('down'),
      row('full', 2),
    ])

    await store.reload()
    await store.reload()
    await store.reload()

    expect(store.get()).toMatchObject({ mode: 'full', version: 2, known: true })
    expect(store.lastReloadError()).toBe('Error')
    expect(warn).toHaveBeenCalledTimes(1)
    await store.reload()
    expect(store.lastReloadError()).toBeNull()
  })

  it('labels a failure by its cause code and never by its message', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const wrapped = new Error('select … params: secret-value', {
      cause: Object.assign(new Error('inner'), { code: '57P01' }),
    })
    const store = storeReading([wrapped])

    await store.reload()

    expect(store.lastReloadError()).toBe('57P01')
  })

  it('calls reload listeners after every reload once known, changed or not, and never while unknown', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const store = storeReading([
      new Error('down'),
      row('full', 1),
      row('full', 1),
      new Error('down'),
    ])
    const seen: MaintenanceModeSnapshot[] = []
    store.onReload((snapshot) => {
      seen.push(snapshot)
    })

    await store.reload()
    expect(seen).toEqual([])
    await store.reload()
    await store.reload()
    await store.reload()

    expect(seen.map((snapshot) => [snapshot.mode, snapshot.version])).toEqual([
      ['full', 1],
      ['full', 1],
      ['full', 1],
    ])
  })

  it('stops calling a removed listener, and contains a listener that throws', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const store = storeReading([row('off', 1), row('off', 2)])
    const removed = vi.fn()
    const remove = store.onReload(removed)
    store.onReload(() => {
      throw new Error('listener bug')
    })

    await store.reload()
    remove()
    await store.reload()

    expect(removed).toHaveBeenCalledTimes(1)
    expect(store.get().version).toBe(2)
    expect(error.mock.calls).toContainEqual([
      'A maintenance-mode reload listener threw',
      { error: new Error('listener bug') },
    ])
  })

  it('reads nothing once stopped', async () => {
    const read = vi.fn(() => Promise.resolve(row('full', 1)))
    const store = createMaintenanceModeStore({ read })

    await store.stop()
    await store.reload()
    await store.start()

    expect(read).not.toHaveBeenCalled()
    expect(store.get().known).toBe(false)
  })
})
