/**
 * @file What the flag definitions fetch did, and how often evaluations met
 * a variant the registry does not declare, counted in Redis so the staff
 * status sees every replica: the time of the last successful fetch and the
 * code of the last failed one (each kept a day), and one counter per minute
 * of undeclared variants (`<prefix>:flags:unknown_variant:<epochMinute>`).
 * Flags never depend on Redis for these: a failed write is ignored and a
 * failed read reports no outcome.
 */
import { isFlagsEnabled } from '@/configs/analytics.config'
import {
  findFlagEntry,
  FLAG_SNAPSHOT_STALE_MS,
  FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES,
  FLAGS,
} from '@/constants/flags.constants'
import { definitionOf, flagStateOf } from '@/services/flags/flag-evaluator.service'
import { getFlagSnapshot } from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { FlagFetchErrorCode, FlagsStatus } from '@/types/flags'
import type { ParsedSnapshot } from '@/validators/flag-definition.validators'

/**
 * How one definitions fetch ended: a 200, a 304, or a failure code.
 */
export type FlagFetchOutcome = 'ok' | 'not_modified' | FlagFetchErrorCode

const MINUTE_MS = 60_000
const LAST_FETCH_TTL_SECONDS = 24 * 60 * 60
const UNKNOWN_VARIANT_TTL_SECONDS = (FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES + 1) * 60
const LAST_FETCH_OK_KEY = ['flags', 'fetch', 'last_ok_at'] as const
const LAST_FETCH_ERROR_KEY = ['flags', 'fetch', 'last_error'] as const

const FETCH_ERROR_CODES: ReadonlySet<string> = new Set<FlagFetchErrorCode>([
  'unauthorized',
  'http_error',
  'timeout',
  'network',
  'body_too_large',
  'invalid_body',
])

/**
 * Keys this process has already warned about, so an undeclared variant
 * logs once per key per process rather than once per evaluation.
 */
const warnedUnknownVariantKeys = new Set<string>()

/**
 * The minute bucket a moment falls in.
 * @param at - The moment.
 * @returns Whole minutes since the Unix epoch.
 */
function epochMinuteOf(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS)
}

/**
 * The undeclared-variant counter of one minute.
 * @param epochMinute - The minute bucket.
 * @returns The Redis key.
 */
function unknownVariantKey(epochMinute: number): string {
  return redisKey('flags', 'unknown_variant', String(epochMinute))
}

/**
 * Record how a definitions fetch ended: a 200 or a 304 sets the last
 * success and clears the last failure; a failure sets its code. Never rejects.
 * @param outcome - How it ended.
 * @param at - When; defaults to now.
 * @returns Resolves once written, or once the write failed.
 */
export async function recordFlagFetch(
  outcome: FlagFetchOutcome,
  at: Date = new Date()
): Promise<void> {
  try {
    const redis = await getRedis()
    await (outcome === 'ok' || outcome === 'not_modified'
      ? redis
          .multi()
          .set(redisKey(...LAST_FETCH_OK_KEY), at.toISOString(), { EX: LAST_FETCH_TTL_SECONDS })
          .del(redisKey(...LAST_FETCH_ERROR_KEY))
          .exec()
      : redis.set(redisKey(...LAST_FETCH_ERROR_KEY), outcome, { EX: LAST_FETCH_TTL_SECONDS }))
  } catch {
    // The status reads no outcome then; the job logs its own failures.
  }
}

/**
 * Count one evaluation that met a variant the registry does not declare
 * (it served the fallback), and warn once per key per process. Never rejects.
 * @param key - The flag key.
 * @param at - When; defaults to now.
 * @returns Resolves once counted, or once the write failed.
 */
export async function recordUnknownVariant(key: string, at: Date = new Date()): Promise<void> {
  if (!warnedUnknownVariantKeys.has(key)) {
    warnedUnknownVariantKeys.add(key)
    logger.warn(
      'PostHog chose a flag variant the registry does not declare; serving the fallback',
      {
        key,
      }
    )
  }
  try {
    const counter = unknownVariantKey(epochMinuteOf(at))
    const redis = await getRedis()
    await redis.multi().incr(counter).expire(counter, UNKNOWN_VARIANT_TTL_SECONDS).exec()
  } catch {
    // The status counts what it can read.
  }
}

/**
 * The registry counts by state in a snapshot.
 * @param snapshot - This replica's snapshot, or null.
 * @returns The counts; all but `registered` are 0 without a snapshot.
 */
function countsOf(
  snapshot: ParsedSnapshot | null
): Omit<FlagsStatus['counts'], 'unknownVariant15m'> {
  const counts = {
    registered: FLAGS.length,
    active: 0,
    inactive: 0,
    missing: 0,
    unsupported: 0,
    unregistered: 0,
  }
  if (snapshot === null) return counts
  for (const entry of FLAGS) counts[flagStateOf(definitionOf(snapshot, entry.key))] += 1
  counts.unregistered = Object.keys(snapshot.flags).filter((key) => !findFlagEntry(key)).length
  return counts
}

/**
 * The feature-flag status (spec §7.3): this process's switch and snapshot,
 * the counts by state, every replica's last fetch outcome, and the
 * undeclared variants of the current minute and the
 * `FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES - 1` before it, read in one `MGET`.
 * Never rejects: when Redis fails it reports no fetch outcome and zero
 * undeclared variants, logged at warn.
 * @param at - The moment staleness and the window are measured to; defaults to now.
 * @returns The status.
 */
export async function getFlagsStatus(at: Date = new Date()): Promise<FlagsStatus> {
  const isEnabled = isFlagsEnabled()
  const snapshot = getFlagSnapshot()
  const isStale =
    isEnabled &&
    (snapshot === null || at.getTime() - Date.parse(snapshot.checkedAt) > FLAG_SNAPSHOT_STALE_MS)
  const status: FlagsStatus = {
    enabled: isEnabled,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    snapshotAt: snapshot?.fetchedAt ?? null,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    checkedAt: snapshot?.checkedAt ?? null,
    stale: isStale,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    lastFetchOk: null,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    lastFetchError: null,
    // eslint-disable-next-line unicorn/no-null -- the contract sends JSON null
    propertyMatchingVersion: snapshot?.propertyMatchingVersion ?? null,
    counts: { ...countsOf(snapshot), unknownVariant15m: 0 },
  }
  const current = epochMinuteOf(at)
  const minutes = Array.from(
    { length: FLAG_UNKNOWN_VARIANT_WINDOW_MINUTES },
    (_, index) => current - index
  )
  try {
    const redis = await getRedis()
    const [lastOk, lastError, ...counters] = await redis.mGet([
      redisKey(...LAST_FETCH_OK_KEY),
      redisKey(...LAST_FETCH_ERROR_KEY),
      ...minutes.map((minute) => unknownVariantKey(minute)),
    ])
    if (typeof lastOk === 'string') status.lastFetchOk = lastOk
    if (typeof lastError === 'string' && FETCH_ERROR_CODES.has(lastError)) {
      status.lastFetchError = lastError as FlagFetchErrorCode
    }
    status.counts.unknownVariant15m = counters.reduce(
      (sum, value) => sum + (Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0),
      0
    )
  } catch (error) {
    logger.warn('Flag counters unavailable; reporting no fetch outcome', { error })
  }
  return status
}
