// tests/integration/jobs/maintenance.job.test.ts
//
// The retention schedule against the real Redis, under this worker's own
// REDIS_KEY_PREFIX. No Worker runs here, so the scheduled job stays delayed
// until afterAll removes it.
import { afterAll, describe, expect, it } from 'vitest'
import { ensureRetentionSchedule, RETENTION_PURGE_JOB } from '@/jobs/maintenance.job'
import { closeQueue, getMaintenanceQueue } from '@/services/queue.service'

describe('ensureRetentionSchedule', () => {
  afterAll(async () => {
    await getMaintenanceQueue().obliterate({ force: true })
    await closeQueue()
  })

  it('registers one daily 03:00 UTC schedule, however many times it is called', async () => {
    await ensureRetentionSchedule()
    await ensureRetentionSchedule()

    const queue = getMaintenanceQueue()
    expect(await queue.getJobSchedulersCount()).toBe(1)
    const scheduler = await queue.getJobScheduler(RETENTION_PURGE_JOB)
    expect(scheduler).toMatchObject({ name: RETENTION_PURGE_JOB, pattern: '0 3 * * *', tz: 'UTC' })
    expect(scheduler?.template?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: { age: 604_800 },
    })
    expect(await queue.getDelayedCount()).toBe(1)
  })
})
