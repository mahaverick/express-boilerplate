/**
 * @file The parsed flag definitions every replica evaluates from. The
 * definitions job writes one snapshot to Redis (`flags:v1:snapshot`, no
 * expiry) and publishes `reload` on `redisKey('flags')`; each replica keeps
 * a copy in memory, loads it at boot, reloads it on a message, and reloads
 * every `FLAG_SNAPSHOT_BACKSTOP_MS` in case a message was missed. A failed
 * reload keeps the copy, and a replica that never loaded one serves every
 * fallback. The message carries no data: replicas read the stored snapshot.
 */
import type { RedisClientType } from 'redis'
import { logger } from '@/services/logger.service'
import { createRedisClient, getRedis, redisKey } from '@/services/redis.service'
import type { ParsedSnapshot } from '@/validators/flag-definition.validators'

/**
 * How often each replica reloads the stored snapshot whether or not a
 * message arrived.
 */
export const FLAG_SNAPSHOT_BACKSTOP_MS = 60_000

const RELOAD_MESSAGE = 'reload'

/**
 * The Redis key of the stored snapshot.
 * @returns `<prefix>:flags:v1:snapshot`.
 */
export function flagSnapshotKey(): string {
  return redisKey('flags', 'v1', 'snapshot')
}

/**
 * The channel the definitions job publishes `reload` on.
 * @returns `<prefix>:flags`.
 */
export function flagSnapshotChannel(): string {
  return redisKey('flags')
}

/**
 * Whether a stored value has the snapshot's shape.
 * @param value - The parsed JSON.
 * @returns True when it has the snapshot's fields.
 */
function isSnapshot(value: unknown): value is ParsedSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.fetchedAt === 'string' &&
    typeof candidate.checkedAt === 'string' &&
    typeof candidate.flags === 'object' &&
    candidate.flags !== null &&
    !Array.isArray(candidate.flags)
  )
}

/**
 * Read the stored snapshot.
 * @returns The snapshot, or null when none is stored.
 * @throws {Error} When Redis fails or the stored value is not a snapshot.
 */
export async function readFlagSnapshot(): Promise<ParsedSnapshot | null> {
  const redis = await getRedis()
  const stored = await redis.get(flagSnapshotKey())
  // eslint-disable-next-line unicorn/no-null -- the contract is null for nothing stored
  if (stored === null) return null
  const parsed = JSON.parse(stored) as unknown
  if (!isSnapshot(parsed)) throw new Error('The stored flag snapshot is not a snapshot')
  return parsed
}

/**
 * Store a snapshot and tell every replica to reload it.
 * @param snapshot - The snapshot.
 * @returns Resolves once stored and published.
 * @throws {Error} When Redis fails.
 */
export async function writeFlagSnapshot(snapshot: ParsedSnapshot): Promise<void> {
  const redis = await getRedis()
  await redis.set(flagSnapshotKey(), JSON.stringify(snapshot))
  await redis.publish(flagSnapshotChannel(), RELOAD_MESSAGE)
}

/**
 * Store a snapshot PostHog confirmed unchanged (a 304) with its new
 * `checkedAt`, without publishing: replicas pick it up on their backstop.
 * @param snapshot - The stored snapshot.
 * @param checkedAt - When PostHog confirmed it.
 * @returns Resolves once stored.
 * @throws {Error} When Redis fails.
 */
export async function touchFlagSnapshot(snapshot: ParsedSnapshot, checkedAt: Date): Promise<void> {
  const redis = await getRedis()
  await redis.set(
    flagSnapshotKey(),
    JSON.stringify({ ...snapshot, checkedAt: checkedAt.toISOString() })
  )
}

/**
 * One replica's in-memory snapshot.
 */
export interface FlagSnapshotStore {
  /**
   * Load the stored snapshot, subscribe to `reload` and start the backstop.
   * Never rejects: with Redis down it keeps serving what it has (nothing at
   * boot) and the backstop retries.
   */
  start: () => Promise<void>
  /**
   * Stop the backstop and close the subscriber. Safe to call twice; a stopped store stays stopped.
   */
  stop: () => Promise<void>
  /**
   * The snapshot in memory, or null when none was ever loaded.
   */
  get: () => ParsedSnapshot | null
  /**
   * Read the stored snapshot into memory now; a failure or nothing stored keeps the copy.
   */
  reload: () => Promise<void>
}

/**
 * Create one replica's snapshot store. The process uses one default store
 * through `startFlagSnapshot`; tests create several to stand for replicas.
 * @param options - Store options.
 * @param options.backstopMs - The backstop interval; defaults to `FLAG_SNAPSHOT_BACKSTOP_MS`.
 * @returns The store, not started.
 */
export function createFlagSnapshotStore(options: { backstopMs?: number } = {}): FlagSnapshotStore {
  const backstopMs = options.backstopMs ?? FLAG_SNAPSHOT_BACKSTOP_MS
  const state: {
    snapshot: ParsedSnapshot | null
    subscriber: RedisClientType | undefined
    subscribing: Promise<void> | undefined
    timer: ReturnType<typeof setInterval> | undefined
    isStarted: boolean
    isClosed: boolean
    isReloadFailing: boolean
  } = {
    // eslint-disable-next-line unicorn/no-null -- the contract is null for no snapshot
    snapshot: null,
    subscriber: undefined,
    subscribing: undefined,
    timer: undefined,
    isStarted: false,
    isClosed: false,
    isReloadFailing: false,
  }

  const reload = async (): Promise<void> => {
    if (state.isClosed) return
    try {
      const stored = await readFlagSnapshot()
      if (stored !== null && !state.isClosed) state.snapshot = stored
      state.isReloadFailing = false
    } catch (error) {
      if (!state.isReloadFailing) {
        logger.warn('Flag snapshot reload failed; keeping the copy in memory', { error })
      }
      state.isReloadFailing = true
    }
  }

  const subscribe = async (): Promise<void> => {
    if (state.isClosed || state.subscriber) return
    const client = createRedisClient()
    state.subscriber = client
    const readiness = { hasBeenReady: false }
    // A message published while the subscriber was reconnecting is lost, so reload on every reconnect.
    client.on('ready', () => {
      if (readiness.hasBeenReady) void reload()
      readiness.hasBeenReady = true
    })
    try {
      await client.connect()
      if (state.isClosed || !client.isReady) throw new Error('Closed while connecting')
      await client.subscribe(flagSnapshotChannel(), () => {
        void reload()
      })
    } catch (error) {
      if (state.subscriber === client) state.subscriber = undefined
      if (client.isOpen) client.destroy()
      if (!state.isClosed) {
        logger.warn('Flag snapshot subscriber failed to start; the backstop keeps reloading', {
          error,
        })
      }
    }
  }

  const ensureSubscriber = (): Promise<void> => {
    state.subscribing ??= (async () => {
      try {
        await subscribe()
      } finally {
        state.subscribing = undefined
      }
    })()
    return state.subscribing
  }

  return {
    start: async () => {
      if (state.isStarted || state.isClosed) return
      state.isStarted = true
      await reload()
      await ensureSubscriber()
      state.timer = setInterval(() => {
        void reload()
        if (!state.subscriber) void ensureSubscriber()
      }, backstopMs)
      state.timer.unref()
    },
    stop: async () => {
      state.isClosed = true
      clearInterval(state.timer)
      state.timer = undefined
      const client = state.subscriber
      state.subscriber = undefined
      if (client?.isOpen) client.destroy()
      if (state.subscribing) await state.subscribing
    },
    get: () => state.snapshot,
    reload,
  }
}

const defaultStore = createFlagSnapshotStore()

/**
 * Start this process's snapshot store, at boot, when flags are enabled.
 * Never rejects.
 * @returns Resolves once the first load and the subscription have been tried.
 */
export async function startFlagSnapshot(): Promise<void> {
  await defaultStore.start()
}

/**
 * Stop this process's snapshot store, for graceful shutdown. Safe to call
 * twice, and when it never started.
 * @returns Resolves once the subscriber is closed.
 */
export async function stopFlagSnapshot(): Promise<void> {
  await defaultStore.stop()
}

/**
 * This process's snapshot.
 * @returns The snapshot in memory, or null when none was loaded (flags
 *   disabled, or Redis unreachable since boot).
 */
export function getFlagSnapshot(): ParsedSnapshot | null {
  return defaultStore.get()
}
