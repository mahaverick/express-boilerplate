/**
 * @file Experiment exposure, recorded by the server only (a browser hook
 * reports to express, which re-evaluates): one `$feature_flag_called`
 * outbox row per session, tenant, flag and recorded response, for every
 * user, opted out of browser analytics or not. A held-out user is recorded
 * as PostHog's `holdout-<id>`, never the control arm. Only a matched
 * condition or a holdout is part of the experiment; every other evaluation
 * records nothing. The dedupe fails open: when Redis fails the exposure is
 * recorded, since a duplicate is harmless and a lost exposure is not. For
 * the same reason a failed outbox insert releases the dedupe key it
 * claimed, so the next report records.
 */
import { createHash } from 'node:crypto'
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { getEnv } from '@/configs/env.config'
import {
  FLAG_EXPOSURE_WORKER_TTL_SECONDS,
  type MultivariateFlagKey,
} from '@/constants/flags.constants'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import { buildFlagExposureEvent } from '@/services/analytics/analytics-event-builder.service'
import { enqueueAnalyticsOrThrow } from '@/services/analytics/analytics-outbox.service'
import { logger } from '@/services/logger.service'
import { withRedisDeadline } from '@/services/redis-deadline.service'
import { getRedis, redisKey } from '@/services/redis.service'
import type { ExposureOrigin, FlagContext, FlagEvaluation, FlagReason } from '@/types/flags'
import { MS_PER_SECOND, requireDurationMs } from '@/utilities/duration.utilities'

/**
 * The reasons that put a user in the experiment: a matched condition (a
 * variant arm) or a holdout. A user out of rollout gets `false` from
 * PostHog, so recording the fallback served to them would fill the control
 * arm with users who were never in the experiment.
 */
const RECORDED_REASONS: ReadonlySet<FlagReason> = new Set<FlagReason>([
  'condition_match',
  'holdout',
])

const ACTOR_HASH_LENGTH = 32

/**
 * The Redis key that deduplicates one exposure:
 * `flags:exp:<sha256(session id, or 'worker:' and the user id) cut to 32
 * hex>:<tenant id or '->:<flag key>:<recorded response>`.
 * @param context - The evaluation context.
 * @param key - The flag key.
 * @param response - The recorded response.
 * @returns The key, in this deployment's namespace.
 */
export function exposureDedupeKey(context: FlagContext, key: string, response: string): string {
  const actor = createHash('sha256')
    .update(context.sessionId ?? `worker:${context.distinctId}`)
    .digest('hex')
    .slice(0, ACTOR_HASH_LENGTH)
  return redisKey('flags', 'exp', actor, context.tenantId ?? '-', key, response)
}

/**
 * How long one exposure is deduplicated: the longest a refresh session
 * lives (`SESSION_ABSOLUTE_TTL`) for a request, a day for a worker's read.
 * @param context - The evaluation context.
 * @returns Seconds.
 */
function dedupeSeconds(context: FlagContext): number {
  if (context.sessionId === null) return FLAG_EXPOSURE_WORKER_TTL_SECONDS
  return Math.ceil(requireDurationMs(getEnv().SESSION_ABSOLUTE_TTL) / MS_PER_SECOND)
}

/**
 * Claim one exposure's dedupe key with `SET NX EX`.
 * @param key - The dedupe key.
 * @param seconds - Its lifetime.
 * @returns True when this is the first claim, or when Redis failed (fail open).
 */
async function isFirstExposure(key: string, seconds: number): Promise<boolean> {
  try {
    const redis = await getRedis()
    const reply = await withRedisDeadline(
      () => redis.set(key, '1', { NX: true, EX: seconds }),
      'flag exposure dedupe'
    )
    return reply !== null
  } catch (error) {
    logger.warn('Exposure dedupe unavailable; recording the exposure anyway', { error })
    return true
  }
}

/**
 * Release a dedupe key whose exposure was not recorded. Best effort: a
 * Redis failure leaves the key to expire.
 * @param key - The dedupe key.
 * @returns True once released, false when Redis failed.
 */
async function didReleaseDedupeKey(key: string): Promise<boolean> {
  try {
    const redis = await getRedis()
    await redis.del(key)
    return true
  } catch {
    return false
  }
}

/**
 * Record one experiment exposure to the outbox, deduplicated. The recorded
 * response is `evaluation.holdoutVariant ?? evaluation.value`, always a
 * string for a multivariate flag. Nothing is recorded for an evaluation
 * that is neither `condition_match` nor `holdout`, or while analytics is
 * off. Never throws: when the outbox insert fails, the dedupe key is
 * released (best effort) and a warn names the flag, the error type and
 * whether the key was released.
 * @param context - The evaluation context (the user, the tenant, the session).
 * @param key - The experiment's key.
 * @param evaluation - The server's own evaluation of it, never a client's value.
 * @param origin - Who reported it: express itself, or a browser app.
 * @returns Resolves once recorded, deduplicated or skipped.
 */
export async function recordExposure(
  context: FlagContext,
  key: MultivariateFlagKey,
  evaluation: FlagEvaluation,
  origin: ExposureOrigin
): Promise<void> {
  if (!RECORDED_REASONS.has(evaluation.reason) || !isAnalyticsEnabled()) return
  const response = evaluation.holdoutVariant ?? String(evaluation.value)
  const dedupeKey = exposureDedupeKey(context, key, response)
  const isFirst = await isFirstExposure(dedupeKey, dedupeSeconds(context))
  if (!isFirst) return
  const row = buildFlagExposureEvent(
    {
      flagKey: key,
      response,
      origin,
      distinctId: context.distinctId,
      tenantId: context.tenantId,
      at: new Date(),
    },
    currentAnalyticsContext()
  )
  try {
    await enqueueAnalyticsOrThrow([row])
  } catch (error) {
    const isReleased = await didReleaseDedupeKey(dedupeKey)
    // The same marker as every other failed outbox write (analytics-outbox.service.ts), so one search finds them all.
    logger.warn('Recording an exposure failed; its dedupe key is released when Redis allows', {
      flag: key,
      reason: error instanceof Error ? error.name : 'unknown',
      released: isReleased,
      events: [row.event],
      analyticsOutboxWriteFailed: 1,
    })
  }
}
