/**
 * @file The parsed flag definitions every replica evaluates from. The
 * definitions job writes one snapshot to Redis (`flags:v1:snapshot`, no
 * expiry) and publishes `reload` on `redisKey('flags')`; each replica keeps
 * a copy in memory, loads it at boot, reloads it on a message, and reloads
 * every `FLAG_SNAPSHOT_BACKSTOP_MS` in case a message was missed. The
 * subscription connects in the background, and reloads once it is
 * established so a message sent before it is not lost. A failed reload
 * keeps the copy, so does a read checked earlier than it (reloads overlap),
 * and a replica that never loaded one serves every fallback. The message
 * carries no data: replicas read the stored snapshot.
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
 * Whether a value is a string `Date.parse` reads as a real time.
 * @param value - Anything.
 * @returns True for a parseable timestamp string.
 */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/**
 * Whether a stored value has the snapshot's shape, with both timestamps
 * parseable (staleness and the older-copy check compare them). A missing
 * `fingerprint` passes (a snapshot stored before fingerprints existed:
 * replicas keep evaluating it, and the definitions job treats it as a
 * mismatch); one that is not a string does not.
 * @param value - The parsed JSON.
 * @returns True when it has the snapshot's fields.
 */
function isSnapshot(value: unknown): value is ParsedSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    isTimestamp(candidate.fetchedAt) &&
    isTimestamp(candidate.checkedAt) &&
    (candidate.fingerprint === undefined || typeof candidate.fingerprint === 'string') &&
    typeof candidate.flags === 'object' &&
    candidate.flags !== null &&
    !Array.isArray(candidate.flags)
  )
}

/**
 * The stored snapshot with the exact string it was parsed from, which a 304
 * touch compares against.
 */
export interface StoredFlagSnapshot {
  /**
   * The stored value, verbatim.
   */
  raw: string
  /**
   * The value parsed.
   */
  snapshot: ParsedSnapshot
}

/**
 * Read the stored snapshot and the exact string it was parsed from.
 * @returns The snapshot and its string, or null when none is stored.
 * @throws {Error} When Redis fails or the stored value is not a snapshot.
 */
export async function readStoredFlagSnapshot(): Promise<StoredFlagSnapshot | null> {
  const redis = await getRedis()
  const raw = await redis.get(flagSnapshotKey())
  // eslint-disable-next-line unicorn/no-null -- the contract is null for nothing stored
  if (raw === null) return null
  const parsed = JSON.parse(raw) as unknown
  if (!isSnapshot(parsed)) throw new Error('The stored flag snapshot is not a snapshot')
  return { raw, snapshot: parsed }
}

/**
 * Read the stored snapshot.
 * @returns The snapshot, or null when none is stored.
 * @throws {Error} When Redis fails or the stored value is not a snapshot.
 */
export async function readFlagSnapshot(): Promise<ParsedSnapshot | null> {
  const stored = await readStoredFlagSnapshot()
  // eslint-disable-next-line unicorn/no-null -- the contract is null for nothing stored
  return stored === null ? null : stored.snapshot
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
 * Rewrites the key (ARGV[2]) only while it still holds exactly ARGV[1]; a
 * missing key is GET's `false`, which equals no string. Returns 1 when it wrote.
 */
const TOUCH_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`

/**
 * Store a snapshot PostHog confirmed unchanged (a 304) with its new
 * `checkedAt`, without publishing: replicas pick it up on their backstop.
 * One Lua script compares and sets, so the write happens only while the
 * stored value is still the exact string this run read. A snapshot another
 * replica stored since (a run outlasting its interval, a stalled job's
 * retry), or one whose `checkedAt` another run's touch moved, is left
 * alone: overwriting it would put back older content, or an earlier
 * `checkedAt`. A replica holding a copy checked later refuses that
 * (`isOlder`), but one without a newer copy (a fresh boot) would load it
 * until the next run replaced it. A deleted snapshot is not recreated.
 * @param stored - The snapshot and the exact string this run read.
 * @param checkedAt - When PostHog confirmed it.
 * @returns `touched` when it was rewritten; `skipped` when the stored value
 *   changed or is gone.
 * @throws {Error} When Redis fails.
 */
export async function touchFlagSnapshot(
  stored: StoredFlagSnapshot,
  checkedAt: Date
): Promise<'touched' | 'skipped'> {
  const redis = await getRedis()
  const touched = JSON.stringify({ ...stored.snapshot, checkedAt: checkedAt.toISOString() })
  const reply = await redis.eval(TOUCH_SCRIPT, {
    keys: [flagSnapshotKey()],
    arguments: [stored.raw, touched],
  })
  return reply === 1 ? 'touched' : 'skipped'
}

/**
 * Whether a snapshot just read is older than the copy in memory: checked
 * earlier. Reloads run concurrently (the message, the backstop, a
 * reconnect), so a read that started first can finish last. Only
 * `checkedAt` is compared: every run that reaches PostHog advances it, while
 * a 304 leaves `fetchedAt` alone, so a copy whose `fetchedAt` is later than
 * the next 200's (worker clock skew, a Redis restored to an older copy)
 * would otherwise refuse every later reload.
 * @param incoming - The snapshot just read.
 * @param current - The copy in memory, or null.
 * @returns True when `incoming` must not replace `current`.
 */
function isOlder(incoming: ParsedSnapshot, current: ParsedSnapshot | null): boolean {
  if (current === null) return false
  return Date.parse(incoming.checkedAt) < Date.parse(current.checkedAt)
}

/**
 * One replica's in-memory snapshot.
 */
export interface FlagSnapshotStore {
  /**
   * Load the stored snapshot and start the backstop, and begin subscribing
   * to `reload` in the background without waiting for it. Never rejects:
   * with Redis down it keeps serving what it has (nothing at boot), and the
   * backstop retries the load and the subscription.
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
   * Read the stored snapshot into memory now; a failure, nothing stored, or
   * a snapshot checked earlier than the copy keeps the copy.
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
      if (stored !== null && !state.isClosed && !isOlder(stored, state.snapshot)) {
        state.snapshot = stored
      }
      state.isReloadFailing = false
    } catch (error) {
      if (!state.isReloadFailing) {
        // The type only: a JSON SyntaxError's message quotes the stored value.
        logger.warn('Flag snapshot reload failed; keeping the copy in memory', {
          reason: error instanceof Error ? error.name : 'unknown',
        })
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
      // A message published before the subscription was established was missed.
      void reload()
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
      if (state.isClosed) return
      void ensureSubscriber()
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
 * @returns Resolves once the first load has been tried; the subscription connects in the background.
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
