/**
 * @file Deletes purged users from PostHog: each tick claims due
 * `analytics_deletions` rows in one autocommit statement, then sends one
 * `persons/bulk_delete/` request with no pool connection held, asking
 * PostHog to delete the persons with their events and recordings. A row
 * leaves the table only once PostHog has queued its deletion, so a PostHog
 * outage of any length only delays it. Inert while the personal API key is
 * not configured: the rows wait.
 */
import { isTimelineEnabled } from '@/configs/analytics.config'
import {
  ANALYTICS_DELETION_BATCH_SIZE,
  ANALYTICS_DELETION_LEASE_SECONDS,
  ANALYTICS_DELETION_OVERDUE_MS,
} from '@/constants/analytics.constants'
import type { AnalyticsDeletionRow } from '@/database/models/analytics-deletion.model'
import { analyticsDeletionRepository } from '@/repositories/analytics-deletion.repository'
import { analyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import {
  posthogApi,
  posthogProjectPath,
  type PosthogApiResult,
} from '@/services/analytics/posthog-api.service'
import { logger } from '@/services/logger.service'

/**
 * What one tick did, in rows: `deleted` were queued for deletion by PostHog
 * and removed, `failed` stay and are due again after their backoff.
 */
export interface DeletionResult {
  deleted: number
  failed: number
}

/**
 * The `persons_found` count of a 2xx answer.
 * @param result - How the call ended.
 * @returns The count, or 0 when the call failed or the body has none.
 */
function personsFoundOf(result: PosthogApiResult): number {
  if (result.kind !== 'ok') return 0
  const found = (result.json as { persons_found?: unknown } | null | undefined)?.persons_found
  return typeof found === 'number' ? found : 0
}

/**
 * Log one `info` line for a tick that deleted rows: the count and the
 * persons PostHog found, never an id.
 * @param deleted - Rows deleted by the tick.
 * @param personsFound - The summed `persons_found` of the answers that deleted them.
 */
function logDeleted(deleted: number, personsFound: number): void {
  if (deleted > 0)
    logger.info('PostHog queued purged users for deletion', { deleted, personsFound })
}

/**
 * The `deletion_errors` list of a 2xx answer.
 * @param result - How the call ended.
 * @returns The list, or undefined when the call failed or the body has none.
 */
function deletionErrorsOf(result: PosthogApiResult): unknown[] | undefined {
  if (result.kind !== 'ok') return undefined
  const errors = (result.json as { deletion_errors?: unknown } | null | undefined)?.deletion_errors
  return Array.isArray(errors) ? errors : undefined
}

/**
 * The `last_error` for a call that did not queue every deletion: the status
 * or the failure class, never a response body.
 * @param result - How the call ended.
 * @returns The error, or undefined when PostHog queued every deletion.
 */
function failureOf(result: PosthogApiResult): string | undefined {
  if (result.kind === 'http_error') return `http_${String(result.status)}`
  if (result.kind !== 'ok') return result.kind
  const errors = deletionErrorsOf(result)
  if (errors === undefined) return `unexpected_body_${String(result.status)}`
  return errors.length === 0 ? undefined : 'deletion_errors'
}

/**
 * The `last_error` values that mean the key or project is wrong, so no retry
 * will help.
 */
const CREDENTIAL_FAILURES: ReadonlySet<string> = new Set(['http_401', 'http_403', 'http_404'])

/**
 * Log a failed tick: at `error` at once when PostHog refused the key or the
 * project (401, 403, 404), at `error` when any of its rows was purged more
 * than `ANALYTICS_DELETION_OVERDUE_MS` ago, otherwise at `warn`. The key is
 * never logged.
 * @param rows - The rows whose deletion failed.
 * @param error - The recorded `last_error`.
 * @param result - How the call ended.
 * @param now - The tick's clock.
 */
function logFailure(
  rows: AnalyticsDeletionRow[],
  error: string,
  result: PosthogApiResult,
  now: Date
): void {
  const overdue = rows.filter(
    (row) => now.getTime() - row.createdAt.getTime() > ANALYTICS_DELETION_OVERDUE_MS
  )
  const meta = {
    rows: rows.length,
    lastError: error,
    deletionErrors: deletionErrorsOf(result)?.length,
  }
  if (CREDENTIAL_FAILURES.has(error)) {
    logger.error(
      'PostHog refused the deletion; check POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID',
      meta
    )
    return
  }
  if (overdue.length > 0) {
    logger.error('PostHog has not deleted purged users for over 24 hours', {
      ...meta,
      overdue: overdue.length,
    })
    return
  }
  logger.warn('PostHog deletion of purged users failed; retrying with backoff', meta)
}

/**
 * Send one tick of purged-user deletions to PostHog.
 *
 * Claims up to `ANALYTICS_DELETION_BATCH_SIZE` due rows under an
 * `ANALYTICS_DELETION_LEASE_SECONDS` lease and sends their ids in one
 * `POST persons/bulk_delete/` with `delete_events` and `delete_recordings`.
 * A 2xx with an empty `deletion_errors` deletes every claimed row, an id
 * PostHog does not know included. Anything else (another status, a timeout,
 * a network error, a non-empty `deletion_errors`) keeps every row, counts a
 * failure and backs it off (`markFailed`), and logs once: at `error` when a
 * row was purged more than a day ago, otherwise at `warn`.
 *
 * A batch of several ids that PostHog answers with a non-empty
 * `deletion_errors` says some id was rejected but not which, and backing the
 * whole batch off together would re-claim them together for ever. So the
 * tick logs one `warn` (the count, no ids) and sends each id in its own
 * request, sequentially, applying the rules above to each; the result counts
 * per id. A timeout, a network error or an http error on the batch says
 * nothing about single ids, so it does not split.
 *
 * Before the request it deletes any outbox rows of the claimed ids, so an
 * event committed after the purge cannot be sent once PostHog has deleted
 * the person. The lease covers one batch request plus one request per claimed
 * id: `ANALYTICS_DELETION_LEASE_SECONDS` is 180 s and
 * `TIMELINE_POSTHOG_TIMEOUT_MS` bounds each call at 15 s.
 * @param now - The clock the claim and backoff are measured against. Defaults to now.
 * @returns How many rows were deleted and how many failed.
 */
export async function processAnalyticsDeletions(now: Date = new Date()): Promise<DeletionResult> {
  if (!isTimelineEnabled()) return { deleted: 0, failed: 0 }
  const rows = await analyticsDeletionRepository.claimDue(
    ANALYTICS_DELETION_BATCH_SIZE,
    ANALYTICS_DELETION_LEASE_SECONDS,
    now
  )
  if (rows.length === 0) return { deleted: 0, failed: 0 }
  const ids = rows.map((row) => row.distinctId)
  // A late event of a claimed id would recreate its person if drained after the deletion.
  await analyticsOutboxRepository.deleteForDistinctIds(ids)
  const result = await sendBulkDelete(ids)
  if (rows.length > 1 && result.kind === 'ok' && failureOf(result) === 'deletion_errors') {
    logger.warn('PostHog rejected part of a deletion batch; sending its ids one by one', {
      rows: rows.length,
    })
    const split = await deleteOneByOne(rows, now)
    logDeleted(split.deleted, split.personsFound)
    return { deleted: split.deleted, failed: split.failed }
  }
  const error = failureOf(result)
  if (error === undefined) {
    const deleted = await analyticsDeletionRepository.deleteByIds(ids)
    logDeleted(deleted, personsFoundOf(result))
    return { deleted, failed: 0 }
  }
  await analyticsDeletionRepository.markFailed(ids, error, now)
  logFailure(rows, error, result, now)
  return { deleted: 0, failed: rows.length }
}

/**
 * One `persons/bulk_delete/` request for the given ids.
 * @param ids - The distinct ids to delete.
 * @returns How the call ended.
 */
function sendBulkDelete(ids: string[]): Promise<PosthogApiResult> {
  return posthogApi('POST', posthogProjectPath('persons/bulk_delete/'), {
    distinct_ids: ids,
    delete_events: true,
    delete_recordings: true,
  })
}

/**
 * Send each claimed row in its own request, one after another, so one id
 * PostHog keeps rejecting cannot hold back the others. Each answer is
 * classified as a batch's would be: the row is deleted on success and
 * backed off on any failure.
 * @param rows - The claimed rows.
 * @param now - The tick's clock.
 * @returns How many rows were deleted and failed, and the summed `persons_found`.
 */
async function deleteOneByOne(
  rows: AnalyticsDeletionRow[],
  now: Date
): Promise<DeletionResult & { personsFound: number }> {
  const outcome = { deleted: 0, failed: 0, personsFound: 0 }
  for (const row of rows) {
    const result = await sendBulkDelete([row.distinctId])
    const error = failureOf(result)
    if (error === undefined) {
      outcome.deleted += await analyticsDeletionRepository.deleteByIds([row.distinctId])
      outcome.personsFound += personsFoundOf(result)
      continue
    }
    await analyticsDeletionRepository.markFailed([row.distinctId], error, now)
    logFailure([row], error, result, now)
    outcome.failed += 1
  }
  return outcome
}

/**
 * Warn when purged users wait for a PostHog deletion that cannot run,
 * because the personal API key or the project id is not set. Called once
 * at boot. Never throws: a failed count is logged at `warn` too.
 * @returns Resolves once the check is done.
 */
export async function warnIfDeletionsPending(): Promise<void> {
  if (isTimelineEnabled()) return
  try {
    const pending = await analyticsDeletionRepository.countPending()
    if (pending === 0) return
    logger.warn(
      'Purged users are waiting to be deleted from PostHog, but POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are not both set; the deletions wait until they are; ignore this on a pod that runs no workers (WORKER_ENABLED=false), and set both on the worker deployment',
      { pending }
    )
  } catch (error) {
    logger.warn('Counting pending PostHog deletions failed', { error })
  }
}
