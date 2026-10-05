/**
 * @file The replica snapshot against the real Redis, under this worker's
 * key prefix: a write reaches two independent stores through pub/sub, the
 * backstop reloads a change that was never published, a failed reload keeps
 * the copy in memory without logging the stored value, a reload never
 * replaces the copy with an older snapshot, a store with nothing stored
 * serves null, and a stopped store stops reloading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFlagSnapshotStore,
  flagSnapshotKey,
  readFlagSnapshot,
  touchFlagSnapshot,
  writeFlagSnapshot,
  type FlagSnapshotStore,
} from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { getRedis } from '@/services/redis.service'
import type { ParsedSnapshot } from '@/validators/flag-definition.validators'

// eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null
const NONE = null
const stores: FlagSnapshotStore[] = []

/**
 * A snapshot with one marker in its ETag.
 * @param marker - Tells snapshots apart.
 * @returns The snapshot.
 */
function snapshot(marker: string): ParsedSnapshot {
  return {
    etag: `W/"${marker}"`,
    fetchedAt: '2026-10-05T12:00:00.000Z',
    checkedAt: '2026-10-05T12:00:00.000Z',
    propertyMatchingVersion: 1,
    tenantGroupIndex: 0,
    flags: {},
  }
}

/**
 * A started store, stopped after the test.
 * @param backstopMs - Its backstop interval.
 * @returns The store.
 */
async function startedStore(backstopMs = 60_000): Promise<FlagSnapshotStore> {
  const store = createFlagSnapshotStore({ backstopMs })
  stores.push(store)
  await store.start()
  return store
}

afterEach(async () => {
  await Promise.all(stores.map((store) => store.stop()))
  stores.length = 0
  const redis = await getRedis()
  await redis.del(flagSnapshotKey())
})

describe('flag snapshot store', () => {
  it('serves null when nothing is stored', async () => {
    const store = await startedStore()
    expect(store.get()).toBeNull()
    await expect(readFlagSnapshot()).resolves.toBeNull()
  })

  it('loads the stored snapshot at start', async () => {
    await writeFlagSnapshot(snapshot('boot'))
    const store = await startedStore()
    expect(store.get()?.etag).toBe('W/"boot"')
  })

  it('reloads every store when a snapshot is written and published', async () => {
    const first = await startedStore()
    const second = await startedStore()
    await writeFlagSnapshot(snapshot('published'))
    await vi.waitFor(() => {
      expect(first.get()?.etag).toBe('W/"published"')
      expect(second.get()?.etag).toBe('W/"published"')
    })
  })

  it('stores the snapshot under the versioned key, with no expiry', async () => {
    await writeFlagSnapshot(snapshot('stored'))
    const redis = await getRedis()
    expect(flagSnapshotKey()).toMatch(/:flags:v1:snapshot$/)
    expect(await redis.ttl(flagSnapshotKey())).toBe(-1)
    await expect(readFlagSnapshot()).resolves.toEqual(snapshot('stored'))
  })

  it('picks up an unpublished change on the backstop', async () => {
    await writeFlagSnapshot(snapshot('first'))
    const store = await startedStore(50)
    await touchFlagSnapshot(snapshot('first'), new Date('2026-10-05T12:05:00.000Z'))
    await vi.waitFor(() => {
      expect(store.get()?.checkedAt).toBe('2026-10-05T12:05:00.000Z')
    })
  })

  it('keeps its copy when a reload fails', async () => {
    await writeFlagSnapshot(snapshot('kept'))
    const store = await startedStore()
    const redis = await getRedis()
    await redis.set(flagSnapshotKey(), 'not json')
    await store.reload()
    expect(store.get()?.etag).toBe('W/"kept"')
    await redis.set(flagSnapshotKey(), JSON.stringify({ flags: 'wrong' }))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"kept"')
  })

  it('logs only the error type when a reload fails, never the stored value', async () => {
    await writeFlagSnapshot(snapshot('kept'))
    const store = await startedStore()
    const redis = await getRedis()
    await redis.set(flagSnapshotKey(), '{"stored-value-fragment"')
    const warn = vi.spyOn(logger, 'warn')
    await store.reload()
    expect(warn).toHaveBeenCalledWith('Flag snapshot reload failed; keeping the copy in memory', {
      reason: 'SyntaxError',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('stored-value-fragment')
    warn.mockRestore()
  })

  it('never replaces its copy with an older snapshot, as a late concurrent read would', async () => {
    const newer = { ...snapshot('newer'), checkedAt: '2026-10-05T12:00:30.000Z' }
    await writeFlagSnapshot(newer)
    const store = await startedStore()
    const redis = await getRedis()
    await redis.set(flagSnapshotKey(), JSON.stringify(snapshot('older-checked')))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"newer"')
    const olderFetch = {
      ...snapshot('older-fetched'),
      fetchedAt: '2026-10-05T11:59:00.000Z',
      checkedAt: '2026-10-05T12:01:00.000Z',
    }
    await redis.set(flagSnapshotKey(), JSON.stringify(olderFetch))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"newer"')
    const same = { ...newer, etag: 'W/"same-times"' }
    await redis.set(flagSnapshotKey(), JSON.stringify(same))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"same-times"')
  })

  it('leaves no backstop timer when stopped while starting', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const store = createFlagSnapshotStore({ backstopMs: 50 })
    const starting = store.start()
    await store.stop()
    await starting
    expect(interval).not.toHaveBeenCalled()
    interval.mockRestore()
  })

  it('stops reloading once stopped', async () => {
    const store = await startedStore(50)
    await store.stop()
    await writeFlagSnapshot(snapshot('after-stop'))
    await store.reload()
    expect(store.get()).toBe(NONE)
  })
})
