/**
 * @file The analytics queue's flag definitions schedule: one fetch of
 * PostHog's `/flags/definitions` every `FLAG_DEFINITIONS_INTERVAL_MS`. The
 * scheduler lives in Redis under `REDIS_KEY_PREFIX`, so every replica that
 * upserts it shares one schedule and each tick runs on one Worker: one
 * fetch per interval, whatever the replica count.
 */
import { isFlagsEnabled } from '@/configs/analytics.config'
import { analyticsDrainJobDefaults } from '@/jobs/analytics.job'
import { recordFlagFetch } from '@/services/flags/flag-counters.service'
import { fetchFlagDefinitions } from '@/services/flags/flag-definitions-client.service'
import {
  readFlagSnapshot,
  touchFlagSnapshot,
  writeFlagSnapshot,
} from '@/services/flags/flag-snapshot.service'
import { logger } from '@/services/logger.service'
import { getAnalyticsQueue } from '@/services/queue.service'
import {
  flagRegistryFingerprint,
  parseDefinitionsResponse,
} from '@/validators/flag-definition.validators'

/**
 * The job's name, and the id of the scheduler that creates it.
 */
export const FLAG_DEFINITIONS_JOB = 'flag-definitions'

/**
 * How often the definitions are fetched.
 */
export const FLAG_DEFINITIONS_INTERVAL_MS = 30_000

/**
 * Register the repeating fetch. Idempotent: every call upserts the same
 * scheduler id. Its jobs take the drain's options: one attempt (the next
 * tick is the retry) and the last 100 failures kept.
 * @returns Resolves once the scheduler and its next job are stored in Redis.
 */
export async function ensureFlagDefinitionsSchedule(): Promise<void> {
  await getAnalyticsQueue().upsertJobScheduler(
    FLAG_DEFINITIONS_JOB,
    { every: FLAG_DEFINITIONS_INTERVAL_MS },
    { name: FLAG_DEFINITIONS_JOB, opts: analyticsDrainJobDefaults }
  )
}

/**
 * Fetch the definitions once, sending the stored snapshot's ETag when its
 * fingerprint matches the running code's (`flagRegistryFingerprint`). A 200
 * is parsed and stored, and every replica is told to reload; a 304 rewrites
 * only the stored `checkedAt`, unpublished; a failure keeps the stored
 * snapshot and records its code. A stored snapshot parsed under another
 * registry or parser version (its fingerprint differs, or it has none), or
 * one that cannot be read, gets an unconditional fetch, so a 200 re-parses
 * it with the current rules. Nothing is fetched while flags are off.
 * @param now - When this run happens; defaults to now.
 * @returns Resolves once the outcome is stored and recorded.
 * @throws {Error} When writing the snapshot in Redis fails; the next tick retries.
 */
export async function runFlagDefinitionsJob(now: Date = new Date()): Promise<void> {
  if (!isFlagsEnabled()) return
  const stored = await readStoredSnapshot()
  const isCurrent = stored?.fingerprint === flagRegistryFingerprint()
  // eslint-disable-next-line unicorn/no-null -- the client's contract is null for an unconditional fetch
  const result = await fetchFlagDefinitions(isCurrent ? stored.etag : null)
  if (result.kind === 'error') {
    logger.warn('Fetching flag definitions failed; keeping the stored snapshot', {
      code: result.code,
      status: result.status,
    })
    await recordFlagFetch(result.code, now)
    return
  }
  if (result.kind === 'not_modified') {
    if (stored) await touchFlagSnapshot(stored, now)
    await recordFlagFetch('not_modified', now)
    return
  }
  const parsed = parseDefinitionsSafely(result.body, result.etag, now)
  if (parsed === undefined) {
    await recordFlagFetch('invalid_body', now)
    return
  }
  await writeFlagSnapshot(parsed)
  await recordFlagFetch('ok', now)
  const flags = Object.values(parsed.flags)
  logger.info('Flag definitions updated', {
    flags: flags.length,
    unsupported: flags.filter((flag) => flag.unsupported !== null).length,
  })
}

/**
 * Read the stored snapshot, treating one that cannot be read (Redis failed,
 * or the value is not a snapshot) as none. The log names the error type only,
 * never the stored value.
 * @returns The stored snapshot, or null.
 */
async function readStoredSnapshot(): Promise<Awaited<ReturnType<typeof readFlagSnapshot>>> {
  try {
    return await readFlagSnapshot()
  } catch (error) {
    logger.warn('The stored flag snapshot could not be read; fetching without an ETag', {
      reason: error instanceof Error ? error.name : 'unknown',
    })
    // eslint-disable-next-line unicorn/no-null -- the snapshot's contract is null for none
    return null
  }
}

/**
 * Parse a definitions body, logging (without the body) when its top level is not the definitions shape.
 * @param body - The parsed JSON body.
 * @param etag - The response's ETag, or null.
 * @param now - When it was fetched.
 * @returns The snapshot, or undefined for a body of the wrong shape.
 */
function parseDefinitionsSafely(
  body: unknown,
  etag: string | null,
  now: Date
): ReturnType<typeof parseDefinitionsResponse> | undefined {
  try {
    return parseDefinitionsResponse(body, etag, now)
  } catch {
    logger.warn('PostHog sent flag definitions of an unexpected shape; keeping the stored snapshot')
    return undefined
  }
}
