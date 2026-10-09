/**
 * @file One replica's in-memory copy of the maintenance mode. Postgres
 * (`maintenance_mode_state`) is the source of truth; a change publishes
 * `reload` on `redisKey('maintenance-mode')`, and every replica rereads the
 * row on that message, on a subscriber reconnect, and every
 * `MAINTENANCE_MODE_RELOAD_INTERVAL_MS` whatever happens (the backstop). No
 * request reads Postgres or Redis for the mode: the gate reads `get()`.
 *
 * A row whose version is not above the copy's is ignored once the copy is
 * known, so overlapping reloads never roll the state back. A replica whose
 * first read fails starts open (`off`, `known: false`), logs at error once
 * and keeps retrying on the backstop; the first successful read then always
 * applies. A later failed read keeps the last known state (logged at warn,
 * once per failing streak): it never flips open or closed on its own.
 */
import type { RedisClientType } from 'redis'
import { MAINTENANCE_MODE_RELOAD_INTERVAL_MS } from '@/constants/maintenance-mode.constants'
import type { MaintenanceModeStateRow } from '@/database/models/maintenance-mode-state.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { readMaintenanceModeState } from '@/repositories/maintenance-mode.repository'
import { logger } from '@/services/logger.service'
import { waitForRedisWrite } from '@/services/redis-deadline.service'
import { createRedisClient, getRedis, redisKey } from '@/services/redis.service'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'

const RELOAD_MESSAGE = 'reload'

/**
 * What a replica serves before its first successful read: open.
 */
const UNKNOWN_SNAPSHOT: MaintenanceModeSnapshot = Object.freeze({
  mode: 'off',
  // eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null for "none"
  message: null,
  // eslint-disable-next-line unicorn/no-null -- as above
  since: null,
  // eslint-disable-next-line unicorn/no-null -- as above
  changedAt: null,
  version: 0,
  known: false,
})

/**
 * The channel a change publishes `reload` on.
 * @returns `<prefix>:maintenance-mode`.
 */
export function maintenanceModeChannel(): string {
  return redisKey('maintenance-mode')
}

/**
 * The in-memory snapshot of a stored row.
 * @param row - The row just read.
 * @returns The snapshot, `known`.
 */
export function snapshotOf(row: MaintenanceModeStateRow): MaintenanceModeSnapshot {
  const isOff = row.mode === 'off'
  const changedAt = row.changedAt.toISOString()
  return {
    mode: row.mode,
    // eslint-disable-next-line unicorn/no-null -- the snapshot's contract uses null for "none"
    message: isOff ? null : row.message,
    // eslint-disable-next-line unicorn/no-null -- as above
    since: isOff ? null : changedAt,
    changedAt,
    version: row.version,
    known: true,
  }
}

/**
 * A short, value-free label for a failed reload: the error's code when it
 * has one (`ECONNREFUSED`, a Postgres SQLSTATE), its own or its cause's,
 * otherwise its class name. Never the message, which can quote a value.
 * @param error - The failure.
 * @returns The label.
 */
function reloadErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const causeCode = (error.cause as { code?: unknown } | undefined)?.code
  return typeof causeCode === 'string' ? causeCode : error.name
}

/**
 * Called after every reload attempt once the mode is known, with the
 * snapshot in memory, whether or not that reload changed it.
 */
export type MaintenanceModeReloadListener = (snapshot: MaintenanceModeSnapshot) => void

/**
 * One replica's in-memory maintenance mode.
 */
export interface MaintenanceModeStore {
  /**
   * Read the row, start the backstop, and begin subscribing in the
   * background. Never rejects: a failed first read leaves the store open
   * and unknown, and the backstop retries it.
   */
  start: () => Promise<void>
  /**
   * Stop the backstop and close the subscriber. Safe to call twice; a stopped store stays stopped.
   */
  stop: () => Promise<void>
  /**
   * The snapshot in memory.
   */
  get: () => MaintenanceModeSnapshot
  /**
   * Read the row now and apply it under the version rule; never rejects.
   */
  reload: () => Promise<void>
  /**
   * Add a listener called after every reload while the mode is known.
   * Returns a function that removes it.
   */
  onReload: (listener: MaintenanceModeReloadListener) => () => void
  /**
   * The label of the last reload's failure, or null when it succeeded.
   */
  lastReloadError: () => string | null
}

/**
 * Create one replica's store. The process uses one default store through
 * `startMaintenanceModeStore`; tests create several to stand for replicas.
 * @param options - Store options.
 * @param options.reloadIntervalMs - The backstop interval; defaults to `MAINTENANCE_MODE_RELOAD_INTERVAL_MS`.
 * @param options.read - Reads the row; defaults to `readMaintenanceModeState`.
 * @returns The store, not started.
 */
export function createMaintenanceModeStore(
  options: { reloadIntervalMs?: number; read?: () => Promise<MaintenanceModeStateRow> } = {}
): MaintenanceModeStore {
  const reloadIntervalMs = options.reloadIntervalMs ?? MAINTENANCE_MODE_RELOAD_INTERVAL_MS
  const read = options.read ?? (() => readMaintenanceModeState())
  const listeners = new Set<MaintenanceModeReloadListener>()
  const state: {
    snapshot: MaintenanceModeSnapshot
    lastReloadError: string | null
    subscriber: RedisClientType | undefined
    subscribing: Promise<void> | undefined
    timer: ReturnType<typeof setInterval> | undefined
    isStarted: boolean
    isClosed: boolean
  } = {
    snapshot: UNKNOWN_SNAPSHOT,
    // eslint-disable-next-line unicorn/no-null -- the contract is null for "no failure"
    lastReloadError: null,
    subscriber: undefined,
    subscribing: undefined,
    timer: undefined,
    isStarted: false,
    isClosed: false,
  }

  const notify = (): void => {
    if (!state.snapshot.known) return
    for (const listener of listeners) {
      try {
        listener(state.snapshot)
      } catch (error) {
        logger.error('A maintenance-mode reload listener threw', { error })
      }
    }
  }

  const reload = async (): Promise<void> => {
    if (state.isClosed) return
    try {
      const row = await read()
      if (state.isClosed) return
      if (!state.snapshot.known || row.version > state.snapshot.version) {
        state.snapshot = snapshotOf(row)
      }
      // eslint-disable-next-line unicorn/no-null -- the contract is null for "no failure"
      state.lastReloadError = null
    } catch (error) {
      // A read that fails after stop() is shutdown noise: say nothing, notify no one.
      if (state.isClosed) return
      // Once per failing streak: the backstop retries every interval.
      if (state.lastReloadError === null) {
        if (state.snapshot.known) {
          logger.warn('Maintenance mode reload failed; keeping the last known mode', {
            error: redactedForLog(error),
          })
        } else {
          logger.error('Maintenance mode could not be read; serving off until it can', {
            error: redactedForLog(error),
          })
        }
      }
      state.lastReloadError = reloadErrorLabel(error)
    }
    notify()
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
      await client.subscribe(maintenanceModeChannel(), () => {
        void reload()
      })
      // A message published before the subscription was established was missed.
      void reload()
    } catch (error) {
      if (state.subscriber === client) state.subscriber = undefined
      if (client.isOpen) client.destroy()
      if (!state.isClosed) {
        logger.warn('Maintenance-mode subscriber failed to start; the backstop keeps reloading', {
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
      }, reloadIntervalMs)
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
    onReload: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    lastReloadError: () => state.lastReloadError,
  }
}

const defaultStore = createMaintenanceModeStore()

/**
 * Start this process's store, at boot, before the server listens. Never rejects.
 * @returns Resolves once the first read has been tried; the subscription connects in the background.
 */
export async function startMaintenanceModeStore(): Promise<void> {
  await defaultStore.start()
}

/**
 * Stop this process's store, for graceful shutdown. Safe to call twice, and
 * when it never started.
 * @returns Resolves once the subscriber is closed.
 */
export async function stopMaintenanceModeStore(): Promise<void> {
  await defaultStore.stop()
}

/**
 * This process's maintenance mode, from memory.
 * @returns The snapshot; `off` and `known: false` until the row has been read once.
 */
export function getMaintenanceMode(): MaintenanceModeSnapshot {
  return defaultStore.get()
}

/**
 * Reread this process's copy now, under the version rule. Never rejects.
 * @returns Resolves once the read has been tried.
 */
export async function reloadMaintenanceMode(): Promise<void> {
  await defaultStore.reload()
}

/**
 * Add a listener to this process's store, called after every reload while
 * the mode is known.
 * @param listener - The listener.
 * @returns A function that removes it.
 */
export function onMaintenanceModeReload(listener: MaintenanceModeReloadListener): () => void {
  return defaultStore.onReload(listener)
}

/**
 * The label of this process's last failed reload.
 * @returns The label, or null when the last reload succeeded.
 */
export function getMaintenanceModeReloadError(): string | null {
  return defaultStore.lastReloadError()
}

/**
 * Log a failed publish.
 * @param error - The failure.
 */
function logUnpublishedChange(error: unknown): void {
  logger.warn('Maintenance-mode change could not be published; replicas reload on the backstop', {
    error,
  })
}

/**
 * Tell every replica to reread the row. A failure is logged and swallowed:
 * the backstop delivers the change within `MAINTENANCE_MODE_RELOAD_INTERVAL_MS`.
 * The change can close routes, so the publish goes through `waitForRedisWrite`:
 * it is always sent, even during a stall cooldown, and the staff request waits
 * for it at most `REDIS_REQUEST_DEADLINE_MS`.
 * @returns Resolves once published, left in flight past the deadline, or logged; never rejects.
 */
export async function publishMaintenanceModeChange(): Promise<void> {
  try {
    await waitForRedisWrite(
      async () => {
        const redis = await getRedis()
        return redis.publish(maintenanceModeChannel(), RELOAD_MESSAGE)
      },
      'maintenance-mode change',
      logUnpublishedChange
    )
  } catch (error) {
    logUnpublishedChange(error)
  }
}
