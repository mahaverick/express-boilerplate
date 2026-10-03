/**
 * @file Exercises the analytics drain schedule against the real Redis, under
 * this worker's own `REDIS_KEY_PREFIX`. No Worker runs in this file, so the
 * scheduled job stays queued until `afterAll` removes it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { ANALYTICS_DRAIN_JOB, ensureAnalyticsDrainSchedule } from '@/jobs/analytics.job'
import { closeQueue, getAnalyticsQueue } from '@/services/queue.service'

describe('ensureAnalyticsDrainSchedule', () => {
  afterAll(async () => {
    await getAnalyticsQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('registers one schedule every ANALYTICS_DRAIN_INTERVAL_MS, however many times it is called', async () => {
    await ensureAnalyticsDrainSchedule()
    await ensureAnalyticsDrainSchedule()

    const queue = getAnalyticsQueue()
    expect(await queue.getJobSchedulersCount()).toBe(1)
    const scheduler = await queue.getJobScheduler(ANALYTICS_DRAIN_JOB)
    expect(scheduler).toMatchObject({ name: ANALYTICS_DRAIN_JOB, every: 5000 })
    expect(scheduler?.template?.opts).toMatchObject({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    })
  })
})
