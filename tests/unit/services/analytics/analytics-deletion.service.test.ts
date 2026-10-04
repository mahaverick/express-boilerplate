/**
 * @file processAnalyticsDeletions' outcome rules and warnIfDeletionsPending,
 * with the repository, the PostHog API client and the config mocked: an
 * unknown id is acknowledged, a non-empty `deletion_errors`, an answer
 * without one, a timeout and a network error each keep the rows, and a
 * failure logs at `error` only once a row is more than a day old. The real
 * database and the fake PostHog are in
 * tests/integration/services/analytics/analytics-deletion.service.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { isTimelineEnabled } from '@/configs/analytics.config'
import type { AnalyticsDeletionRow } from '@/database/models/analytics-deletion.model'
import { AnalyticsDeletionRepository } from '@/repositories/analytics-deletion.repository'
import { AnalyticsOutboxRepository } from '@/repositories/analytics-outbox.repository'
import {
  processAnalyticsDeletions,
  warnIfDeletionsPending,
} from '@/services/analytics/analytics-deletion.service'
import { posthogApi, type PosthogApiResult } from '@/services/analytics/posthog-api.service'
import { logger } from '@/services/logger.service'

vi.mock('@/configs/analytics.config', () => ({ isTimelineEnabled: vi.fn(() => true) }))
vi.mock('@/services/analytics/posthog-api.service', () => ({
  posthogApi: vi.fn(),
  posthogProjectPath: (suffix: string) => `/api/projects/7/${suffix}`,
}))

const NOW = new Date('2030-01-02T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A claimed row.
 * @param distinctId - Its id.
 * @param createdAt - When the purge queued it.
 * @returns The row.
 */
function claimed(distinctId: string, createdAt: Date = NOW): AnalyticsDeletionRow {
  // eslint-disable-next-line unicorn/no-null -- the column's "never failed" state
  return { distinctId, notBefore: NOW, attempts: 0, lastError: null, createdAt }
}

/**
 * A 202 with the given `deletion_errors`.
 * @param deletionErrors - The list PostHog returns.
 * @returns The result.
 */
function accepted(deletionErrors: unknown[]): PosthogApiResult {
  return {
    kind: 'ok',
    status: 202,
    json: {
      persons_found: 0,
      persons_queued_for_deletion: 0,
      events_queued_for_deletion: 0,
      recordings_queued_for_deletion: 0,
      deletion_errors: deletionErrors,
    },
  }
}

/**
 * Spies on the repository's prototype, which reaches the service's shared
 * instance. Importing the real class does not touch Postgres: the client
 * connects on the first query, and no test here lets one run.
 */
const repository: {
  claimDue?: MockInstance<AnalyticsDeletionRepository['claimDue']>
  deleteByIds?: MockInstance<AnalyticsDeletionRepository['deleteByIds']>
  markFailed?: MockInstance<AnalyticsDeletionRepository['markFailed']>
  countPending?: MockInstance<AnalyticsDeletionRepository['countPending']>
  deleteOutbox?: MockInstance<AnalyticsOutboxRepository['deleteForDistinctIds']>
} = {}

/**
 * One of the repository spies.
 * @param name - The method.
 * @returns Its spy.
 */
function spy<K extends keyof typeof repository>(name: K): NonNullable<(typeof repository)[K]> {
  const found = repository[name]
  if (!found) throw new Error(`no spy on ${name}`)
  return found
}

beforeEach(() => {
  vi.mocked(isTimelineEnabled).mockReturnValue(true)
  const prototype = AnalyticsDeletionRepository.prototype
  repository.claimDue = vi.spyOn(prototype, 'claimDue').mockResolvedValue([claimed('user-a')])
  repository.deleteByIds = vi.spyOn(prototype, 'deleteByIds').mockResolvedValue(1)
  repository.markFailed = vi.spyOn(prototype, 'markFailed').mockResolvedValue()
  repository.countPending = vi.spyOn(prototype, 'countPending').mockResolvedValue(0)
  repository.deleteOutbox = vi
    .spyOn(AnalyticsOutboxRepository.prototype, 'deleteForDistinctIds')
    .mockResolvedValue(0)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('processAnalyticsDeletions', () => {
  it('claims ten rows under a two-minute lease and posts their ids to persons/bulk_delete/', async () => {
    vi.mocked(posthogApi).mockResolvedValue(accepted([]))

    await processAnalyticsDeletions(NOW)

    expect(spy('claimDue')).toHaveBeenCalledWith(10, 120, NOW)
    expect(posthogApi).toHaveBeenCalledWith('POST', '/api/projects/7/persons/bulk_delete/', {
      distinct_ids: ['user-a'],
      delete_events: true,
      delete_recordings: true,
    })
  })

  it('deletes the outbox rows of the claimed ids before it calls PostHog', async () => {
    vi.mocked(posthogApi).mockResolvedValue(accepted([]))

    await processAnalyticsDeletions(NOW)

    expect(spy('deleteOutbox')).toHaveBeenCalledWith(['user-a'])
    expect(spy('deleteOutbox').mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(posthogApi).mock.invocationCallOrder[0] ?? 0
    )
  })

  it('acknowledges an id PostHog does not know (persons_found 0) and deletes its row', async () => {
    vi.mocked(posthogApi).mockResolvedValue(accepted([]))

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 1, failed: 0 })

    expect(spy('deleteByIds')).toHaveBeenCalledWith(['user-a'])
    expect(spy('markFailed')).not.toHaveBeenCalled()
  })

  it.each<[string, PosthogApiResult, string]>([
    ['a non-empty deletion_errors', accepted([{ id: 'user-a' }]), 'deletion_errors'],
    [
      'a 2xx with no deletion_errors list',
      { kind: 'ok', status: 202, json: {} },
      'unexpected_body_202',
    ],
    ['a 2xx with no body', { kind: 'ok', status: 204, json: undefined }, 'unexpected_body_204'],
    ['a 429', { kind: 'http_error', status: 429 }, 'http_429'],
    ['a timeout', { kind: 'timeout' }, 'timeout'],
    ['a network error', { kind: 'network' }, 'network'],
  ])('keeps the rows on %s, recording %s', async (_case, result, lastError) => {
    vi.mocked(posthogApi).mockResolvedValue(result)

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 1 })

    expect(spy('markFailed')).toHaveBeenCalledWith(['user-a'], lastError, NOW)
    expect(spy('deleteByIds')).not.toHaveBeenCalled()
  })

  it('logs the deletion_errors count, never the list', async () => {
    vi.mocked(posthogApi).mockResolvedValue(accepted([{ id: 'user-a', detail: 'boom' }, 'x']))
    const warn = vi.spyOn(logger, 'warn')

    await processAnalyticsDeletions(NOW)

    expect(warn).toHaveBeenCalledWith(
      'PostHog deletion of purged users failed; retrying with backoff',
      { rows: 1, lastError: 'deletion_errors', deletionErrors: 2 }
    )
  })

  it('logs a failure at warn up to a day after the purge, and at error past it', async () => {
    vi.mocked(posthogApi).mockResolvedValue({ kind: 'http_error', status: 503 })
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')

    const exactlyADayAgo = new Date(NOW.getTime() - DAY_MS)
    spy('claimDue').mockResolvedValueOnce([claimed('exactly-a-day', exactlyADayAgo)])
    await processAnalyticsDeletions(NOW)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()

    const overADayAgo = new Date(NOW.getTime() - DAY_MS - 1)
    spy('claimDue').mockResolvedValueOnce([claimed('fresh'), claimed('overdue', overADayAgo)])
    await processAnalyticsDeletions(NOW)
    expect(error).toHaveBeenCalledWith('PostHog has not deleted purged users for over 24 hours', {
      rows: 2,
      lastError: 'http_503',
      deletionErrors: undefined,
      overdue: 1,
    })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('claims nothing and calls nothing when no row is due', async () => {
    spy('claimDue').mockResolvedValue([])

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 0 })

    expect(posthogApi).not.toHaveBeenCalled()
  })

  it('touches neither the table nor PostHog while the timeline is not configured', async () => {
    vi.mocked(isTimelineEnabled).mockReturnValue(false)

    await expect(processAnalyticsDeletions(NOW)).resolves.toEqual({ deleted: 0, failed: 0 })

    expect(spy('claimDue')).not.toHaveBeenCalled()
    expect(spy('deleteOutbox')).not.toHaveBeenCalled()
    expect(posthogApi).not.toHaveBeenCalled()
  })
})

describe('warnIfDeletionsPending', () => {
  it('warns with the count when rows wait and the timeline is not configured', async () => {
    vi.mocked(isTimelineEnabled).mockReturnValue(false)
    spy('countPending').mockResolvedValue(3)
    const warn = vi.spyOn(logger, 'warn')

    await warnIfDeletionsPending()

    expect(warn).toHaveBeenCalledWith(
      'Purged users are waiting to be deleted from PostHog, but POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are not both set; the deletions wait until they are; ignore this on a pod that runs no workers (WORKER_ENABLED=false), and set both on the worker deployment',
      { pending: 3 }
    )
  })

  it('stays quiet with no pending rows, and does not count while the timeline is configured', async () => {
    vi.mocked(isTimelineEnabled).mockReturnValue(false)
    spy('countPending').mockResolvedValue(0)
    const warn = vi.spyOn(logger, 'warn')

    await warnIfDeletionsPending()
    vi.mocked(isTimelineEnabled).mockReturnValue(true)
    await warnIfDeletionsPending()

    expect(warn).not.toHaveBeenCalled()
    expect(spy('countPending')).toHaveBeenCalledOnce()
  })

  it('logs a failed count at warn and never rejects', async () => {
    vi.mocked(isTimelineEnabled).mockReturnValue(false)
    const failure = new Error('database unreachable')
    spy('countPending').mockRejectedValue(failure)
    const warn = vi.spyOn(logger, 'warn')

    await expect(warnIfDeletionsPending()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('Counting pending PostHog deletions failed', {
      error: failure,
    })
  })
})
