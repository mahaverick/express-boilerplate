/**
 * @file The replica snapshot against the real Redis, under this worker's
 * key prefix: a write reaches two independent stores through pub/sub, the
 * backstop reloads a change that was never published, a failed reload keeps
 * the copy in memory without logging the stored value, a reload never
 * replaces the copy with an older snapshot, a store with nothing stored
 * serves null, and a stopped store stops reloading. A 304 touch rewrites
 * `checkedAt` only while the stored value is still the exact string its run
 * read: a snapshot another replica stored meanwhile survives it unchanged,
 * and a deleted one is not recreated. `stop()` closes the subscriber, a
 * reconnect reloads, and neither `start()` nor `stop()` waits on a
 * subscriber whose handshake never completes (a hung Redis or proxy).
 */
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFlagSnapshotStore,
  flagSnapshotChannel,
  flagSnapshotKey,
  readFlagSnapshot,
  readStoredFlagSnapshot,
  touchFlagSnapshot,
  writeFlagSnapshot,
  type FlagSnapshotStore,
} from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { getRedis, REDIS_CONNECT_TIMEOUT_MS } from '@/services/redis.service'
import type { ParsedSnapshot } from '@/validators/flag-definition.validators'
import { waitUntil } from '../../../helpers/timing'

/**
 * Where the next client `createClient` builds is pointed: `redirectNext` marks
 * the snapshot subscriber (the shared client already exists by then), which
 * goes to `url` when set and is otherwise named so `CLIENT LIST` finds it.
 */
const subscriber = vi.hoisted(() => ({
  url: undefined as string | undefined,
  redirectNext: false,
}))

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>()
  return {
    ...actual,
    createClient: (options: Parameters<typeof actual.createClient>[0]) => {
      const isSubscriber = subscriber.redirectNext
      subscriber.redirectNext = false
      return actual.createClient({
        ...options,
        ...(isSubscriber && subscriber.url !== undefined && { url: subscriber.url }),
        ...(isSubscriber && subscriber.url === undefined && { name: 'flag-snapshot-subscriber' }),
      })
    },
  }
})

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

/**
 * How many clients are subscribed to the reload channel.
 * @returns The `PUBSUB NUMSUB` count.
 */
async function subscriberCount(): Promise<number> {
  const redis = await getRedis()
  const reply: unknown = await redis.sendCommand(['PUBSUB', 'NUMSUB', flagSnapshotChannel()])
  return Array.isArray(reply) ? Number(reply[1]) : 0
}

beforeEach(async () => {
  subscriber.url = undefined
  subscriber.redirectNext = false
  // Another file in this worker may have left a snapshot under the shared prefix.
  const redis = await getRedis()
  await redis.del(flagSnapshotKey())
})

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
    const stored = await readStoredFlagSnapshot()
    if (!stored) throw new Error('the snapshot was not stored')
    await touchFlagSnapshot(stored, new Date('2026-10-05T12:05:00.000Z'))
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

  it('never replaces its copy with an earlier-checked snapshot, as a late concurrent read would', async () => {
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
    expect(store.get()?.etag).toBe('W/"older-fetched"')
    const same = { ...olderFetch, etag: 'W/"same-times"' }
    await redis.set(flagSnapshotKey(), JSON.stringify(same))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"same-times"')
  })

  it('applies a later-checked snapshot even when its copy was fetched later (clock skew, a restored Redis)', async () => {
    const skewed = {
      ...snapshot('skewed'),
      fetchedAt: '2026-10-05T12:10:00.000Z',
      checkedAt: '2026-10-05T12:10:00.000Z',
    }
    await writeFlagSnapshot(skewed)
    const store = await startedStore()
    const killed = {
      ...snapshot('killed'),
      fetchedAt: '2026-10-05T12:05:00.000Z',
      checkedAt: '2026-10-05T12:10:30.000Z',
    }
    const redis = await getRedis()
    await redis.set(flagSnapshotKey(), JSON.stringify(killed))
    await store.reload()
    expect(store.get()?.etag).toBe('W/"killed"')
  })

  it.each(['fetchedAt', 'checkedAt'])(
    'refuses a stored snapshot whose %s does not parse, keeping the copy',
    async (field) => {
      await writeFlagSnapshot(snapshot('good'))
      const store = await startedStore()
      const redis = await getRedis()
      await redis.set(flagSnapshotKey(), JSON.stringify({ ...snapshot('bad'), [field]: 'garbage' }))
      await expect(readFlagSnapshot()).rejects.toThrow('The stored flag snapshot is not a snapshot')
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      await store.reload()
      expect(store.get()?.etag).toBe('W/"good"')
      expect(warn).toHaveBeenCalledWith('Flag snapshot reload failed; keeping the copy in memory', {
        reason: 'Error',
      })
      warn.mockRestore()
    }
  )

  it('leaves no backstop timer when stopped while starting', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    try {
      const store = createFlagSnapshotStore({ backstopMs: 50 })
      const starting = store.start()
      await store.stop()
      await starting
      expect(interval).not.toHaveBeenCalled()
    } finally {
      interval.mockRestore()
    }
  })

  it('stops reloading once stopped', async () => {
    const store = await startedStore(50)
    await store.stop()
    await writeFlagSnapshot(snapshot('after-stop'))
    await store.reload()
    expect(store.get()).toBe(NONE)
  })
})

describe('the subscriber: stop() and reconnect', () => {
  it('stop() closes the subscriber connection', async () => {
    const store = createFlagSnapshotStore({ backstopMs: 600_000 })
    stores.push(store)
    subscriber.redirectNext = true
    await store.start()
    await vi.waitFor(async () => expect(await subscriberCount()).toBe(1), { timeout: 5000 })
    await store.stop()
    await vi.waitFor(async () => expect(await subscriberCount()).toBe(0), { timeout: 5000 })
  })

  it('reloads after the subscriber reconnects (a publish during the gap is lost)', async () => {
    const store = createFlagSnapshotStore({ backstopMs: 600_000 })
    stores.push(store)
    subscriber.redirectNext = true
    await store.start()
    await vi.waitFor(async () => expect(await subscriberCount()).toBe(1), { timeout: 5000 })
    const redis = await getRedis()
    // Written without a publish, as if the publish fell in the reconnect gap.
    await redis.set(flagSnapshotKey(), JSON.stringify(snapshot('during-gap')))
    const reply: unknown = await redis.sendCommand(['CLIENT', 'LIST'])
    const list = typeof reply === 'string' ? reply : ''
    const id = /id=(\d+)/.exec(
      list.split('\n').find((line) => line.includes('name=flag-snapshot-subscriber')) ?? ''
    )?.[1]
    expect(id).toBeDefined()
    await redis.sendCommand(['CLIENT', 'KILL', 'ID', id ?? ''])
    await vi.waitFor(() => expect(store.get()?.etag).toBe('W/"during-gap"'), { timeout: 5000 })
  })
})

/**
 * A TCP server that accepts and never answers, but reads so a peer's close is
 * seen; the next subscriber is pointed at it.
 * @returns The sockets it has accepted, and a function that closes it all.
 */
async function silentServer(): Promise<{ accepted: net.Socket[]; close: () => void }> {
  const accepted: net.Socket[] = []
  const server = net.createServer((socket) => {
    accepted.push(socket)
    socket.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  subscriber.url = `redis://127.0.0.1:${String((server.address() as net.AddressInfo).port)}`
  return {
    accepted,
    close: () => {
      for (const socket of accepted) socket.destroy()
      server.close()
    },
  }
}

describe('start() and stop() while the subscriber never finishes its handshake', () => {
  it('stop() closes a connected subscriber whose peer never answers', async () => {
    const silent = await silentServer()
    try {
      const store = createFlagSnapshotStore({ backstopMs: 600_000 })
      stores.push(store)
      subscriber.redirectNext = true
      await store.start()
      await waitUntil(() => silent.accepted.length === 1, {
        message: 'the subscriber reached the silent server',
      })
      const stopping = Date.now()
      await store.stop()
      // Half of STOP_SUBSCRIBER_WAIT_MS (1 s), so a stop() that fell back to that wait fails; measured ~100 ms.
      expect(Date.now() - stopping).toBeLessThan(500)
      await waitUntil(() => silent.accepted[0]?.destroyed, {
        message: 'the connected subscriber is closed by stop()',
        // Well inside the 5 s handshake deadline, which would otherwise close it; measured in ms.
        timeout: 1000,
      })
    } finally {
      silent.close()
    }
  })

  it('start() and stop() resolve before the subscriber has even connected', async () => {
    const silent = await silentServer()
    try {
      const redis = await getRedis()
      await redis.set(flagSnapshotKey(), JSON.stringify(snapshot('boot')))
      const store = createFlagSnapshotStore({ backstopMs: 600_000 })
      stores.push(store)
      const started = Date.now()
      subscriber.redirectNext = true
      await store.start()
      // start() returns after the first load: far under the handshake deadline.
      expect(Date.now() - started).toBeLessThan(REDIS_CONNECT_TIMEOUT_MS - 1000)
      expect(store.get()?.etag).toBe('W/"boot"')
      // Returns at STOP_SUBSCRIBER_WAIT_MS (1 s); a stop() waiting out REDIS_CONNECT_TIMEOUT_MS (5 s) fails.
      const stopping = Date.now()
      await store.stop()
      expect(Date.now() - stopping).toBeLessThan(REDIS_CONNECT_TIMEOUT_MS - 1000)
    } finally {
      silent.close()
    }
  })
})

describe('touchFlagSnapshot', () => {
  const TOUCHED_AT = new Date('2026-10-05T12:05:00.000Z')

  it('advances checkedAt, and nothing else, while the stored value is the one read', async () => {
    await writeFlagSnapshot({ ...snapshot('same'), fingerprint: 'fingerprint0' })
    const stored = await readStoredFlagSnapshot()
    if (!stored) throw new Error('the snapshot was not stored')

    await expect(touchFlagSnapshot(stored, TOUCHED_AT)).resolves.toBe('touched')

    await expect(readFlagSnapshot()).resolves.toEqual({
      ...snapshot('same'),
      fingerprint: 'fingerprint0',
      checkedAt: TOUCHED_AT.toISOString(),
    })
  })

  it('leaves a snapshot another replica stored since the read unchanged, content and checkedAt', async () => {
    await writeFlagSnapshot(snapshot('read-by-this-run'))
    const stale = await readStoredFlagSnapshot()
    if (!stale) throw new Error('the snapshot was not stored')
    const newer = {
      ...snapshot('stored-by-another-replica'),
      checkedAt: '2026-10-05T12:01:00.000Z',
    }
    await writeFlagSnapshot(newer)
    const redis = await getRedis()
    const before = await redis.get(flagSnapshotKey())

    await expect(touchFlagSnapshot(stale, TOUCHED_AT)).resolves.toBe('skipped')

    expect(await redis.get(flagSnapshotKey())).toBe(before)
    await expect(readFlagSnapshot()).resolves.toEqual(newer)
  })

  it('leaves a copy another run touched since the read alone: any change to the stored string skips', async () => {
    await writeFlagSnapshot(snapshot('touched-twice'))
    const read = await readStoredFlagSnapshot()
    if (!read) throw new Error('the snapshot was not stored')
    await expect(touchFlagSnapshot(read, new Date('2026-10-05T12:04:00.000Z'))).resolves.toBe(
      'touched'
    )

    await expect(touchFlagSnapshot(read, TOUCHED_AT)).resolves.toBe('skipped')

    await expect(readFlagSnapshot()).resolves.toMatchObject({
      checkedAt: '2026-10-05T12:04:00.000Z',
    })
  })

  it('writes nothing when the snapshot was deleted since the read', async () => {
    await writeFlagSnapshot(snapshot('deleted'))
    const stored = await readStoredFlagSnapshot()
    if (!stored) throw new Error('the snapshot was not stored')
    const redis = await getRedis()
    await redis.del(flagSnapshotKey())

    await expect(touchFlagSnapshot(stored, TOUCHED_AT)).resolves.toBe('skipped')

    expect(await redis.exists(flagSnapshotKey())).toBe(0)
  })

  it('reads the stored string verbatim alongside the parsed snapshot', async () => {
    const redis = await getRedis()
    const raw = JSON.stringify({ ...snapshot('verbatim'), extra: 1 })
    await redis.set(flagSnapshotKey(), raw)

    const stored = await readStoredFlagSnapshot()

    expect(stored?.raw).toBe(raw)
    expect(stored?.snapshot.etag).toBe('W/"verbatim"')
    await redis.del(flagSnapshotKey())
    await expect(readStoredFlagSnapshot()).resolves.toBeNull()
  })
})
