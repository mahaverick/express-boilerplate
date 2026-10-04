/**
 * @file Exercises the PostHog deletion schedule against the real Redis,
 * under this worker's own `REDIS_KEY_PREFIX`. No Worker runs in this file,
 * so the scheduled job stays queued until `afterAll` removes it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { ANALYTICS_DELETION_INTERVAL_MS } from '@/constants/analytics.constants'
import {
  ANALYTICS_DELETIONS_JOB,
  ensureAnalyticsDeletionSchedule,
} from '@/jobs/analytics-deletion.job'
import { closeQueue, getAnalyticsQueue } from '@/services/queue.service'

describe('ensureAnalyticsDeletionSchedule', () => {
  afterAll(async () => {
    await getAnalyticsQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('registers one schedule every minute on the analytics queue, however many times it is called', async () => {
    await ensureAnalyticsDeletionSchedule()
    await ensureAnalyticsDeletionSchedule()

    const queue = getAnalyticsQueue()
    expect(await queue.getJobSchedulersCount()).toBe(1)
    const scheduler = await queue.getJobScheduler(ANALYTICS_DELETIONS_JOB)
    expect(ANALYTICS_DELETION_INTERVAL_MS).toBe(60_000)
    expect(scheduler).toMatchObject({ name: 'analytics-deletions', every: 60_000 })
    expect(scheduler?.template?.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    })
  })
})
