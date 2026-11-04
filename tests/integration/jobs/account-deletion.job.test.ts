/**
 * @file The daily due-soon alert for account deletion requests: its schedule
 * at 04:00 UTC, and `alertDueSoonDeletions(now)`, which alerts every platform
 * admin once per open request due within five days of `now`. `now` is years
 * in the past, so no other file's request falls inside its window. The alert
 * is a staff-only notification with its email, so the file runs its own
 * notification and email Workers.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  ACCOUNT_DELETION_DUE_SOON_JOB,
  ensureAccountDeletionSchedule,
} from '@/jobs/account-deletion.job'
import * as notificationJob from '@/jobs/notification.job'
import { alertDueSoonDeletions } from '@/services/account-deletion.service'
import { sql } from '@/services/database.service'
import {
  closeQueue,
  getAccountDeletionQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { formatUtcDateTime } from '@/utilities/date-text.utilities'
import { startEmailWorker } from '@/workers/email.worker'
import { startNotificationWorker } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { findMailpitMessages } from '../../helpers/mailpit'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { waitUntil } from '../../helpers/timing'

const MS_PER_DAY = 86_400_000

/**
 * Each test's `now`, years before any real request, and a millisecond
 * apart per test so no dedupe key is shared between tests.
 */
const BASE_NOW = Date.parse('2001-03-01T09:00:00.000Z')

const emailWorker = startEmailWorker()
const notificationWorker = startNotificationWorker()

/**
 * Every user id whose deletion requests `afterEach` removes before the
 * users: the foreign key is RESTRICT.
 */
const requesterIds: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  if (requesterIds.length > 0) {
    await sql`delete from notifications where type = 'account_deletion_requested'`
    await sql`delete from account_deletion_requests where user_id = any(${requesterIds})`
    requesterIds.length = 0
  }
  await truncateAuditLogs()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await emailWorker.close()
  await notificationWorker.close()
  await getAccountDeletionQueue().obliterate({ force: true })
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * An open request for a new tracked customer, due `daysAfterNow` after `now`.
 * @param now - The run's clock.
 * @param daysAfterNow - Days from `now` to the due date.
 * @returns The request's id and due date.
 */
async function openRequestDue(
  now: Date,
  daysAfterNow: number
): Promise<{ id: string; dueAt: Date }> {
  const user = await createTrackedUser()
  requesterIds.push(user.id)
  const dueAt = new Date(now.getTime() + daysAfterNow * MS_PER_DAY)
  const requestedAt = new Date(dueAt.getTime() - 30 * MS_PER_DAY)
  const [row] = await sql<{ id: string }[]>`
    insert into account_deletion_requests (user_id, requested_at, due_at, status)
    values (${user.id}, ${requestedAt.toISOString()}::timestamptz, ${dueAt.toISOString()}::timestamptz, 'open')
    returning id`
  if (!row) throw new Error('no request inserted')
  return { id: row.id, dueAt }
}

/**
 * The deletion notices one admin holds for one request.
 * @param adminId - The admin.
 * @param requestId - The request.
 */
async function noticesFor(
  adminId: string,
  requestId: string
): Promise<{ title: string; body: string }[]> {
  return sql<{ title: string; body: string }[]>`
    select title, body from notifications
    where user_id = ${adminId} and type = 'account_deletion_requested'
      and metadata->>'requestId' = ${requestId}`
}

/**
 * Wait for an admin's first notice for a request.
 * @param adminId - The admin.
 * @param requestId - The request.
 */
async function waitForNotice(
  adminId: string,
  requestId: string
): Promise<{ title: string; body: string }[]> {
  return waitUntil(
    async () => {
      const rows = await noticesFor(adminId, requestId)
      return rows.length > 0 ? rows : undefined
    },
    { message: 'the due-soon notice row' }
  )
}

describe('ensureAccountDeletionSchedule', () => {
  it('registers one daily 04:00 UTC schedule, however many times it is called', async () => {
    await ensureAccountDeletionSchedule()
    await ensureAccountDeletionSchedule()

    const queue = getAccountDeletionQueue()
    expect(await queue.getJobSchedulersCount()).toBe(1)
    const scheduler = await queue.getJobScheduler(ACCOUNT_DELETION_DUE_SOON_JOB)
    expect(scheduler).toMatchObject({
      name: ACCOUNT_DELETION_DUE_SOON_JOB,
      pattern: '0 4 * * *',
      tz: 'UTC',
    })
  })
})

describe('alertDueSoonDeletions', () => {
  it('the job alerts once for a request due in 4 days and not for one due in 10', async () => {
    const now = new Date(BASE_NOW)
    const { user: admin } = await createTrackedStaff('admin')
    const dueSoon = await openRequestDue(now, 4)
    const later = await openRequestDue(now, 10)

    const alerted = await alertDueSoonDeletions(now)

    expect(alerted).toEqual([dueSoon.id])
    const notices = await waitForNotice(admin.id, dueSoon.id)
    expect(notices).toEqual([
      {
        title: 'Account deletion due within 5 days',
        body: `A customer's account deletion is due by ${formatUtcDateTime(dueSoon.dueAt)}. Complete it in Deletion requests before then.`,
      },
    ])
    // The run returned only the due-soon request, so no job was queued for the later one.
    expect(await noticesFor(admin.id, later.id)).toEqual([])
    const mail = await waitUntil(
      async () => {
        const found = await findMailpitMessages(admin.email)
        return found.length > 0 ? found : undefined
      },
      { message: 'the due-soon alert mail' }
    )
    expect(mail).toHaveLength(1)
    expect(mail[0]?.Subject).toBe('Account deletion due within 5 days')
  })

  it('the job does not alert twice for the same request', async () => {
    const now = new Date(BASE_NOW + 1)
    const { user: admin } = await createTrackedStaff('admin')
    const dueSoon = await openRequestDue(now, 2)

    expect(await alertDueSoonDeletions(now)).toEqual([dueSoon.id])
    await waitForNotice(admin.id, dueSoon.id)

    // A day later the request is still open and still inside the window.
    const nextDay = new Date(now.getTime() + MS_PER_DAY)
    expect(await alertDueSoonDeletions(nextDay)).toEqual([])
    expect(await noticesFor(admin.id, dueSoon.id)).toHaveLength(1)
  })

  it('skips a completed request', async () => {
    const now = new Date(BASE_NOW + 2)
    await createTrackedStaff('admin')
    const dueSoon = await openRequestDue(now, 1)
    await sql`
      update account_deletion_requests set status = 'completed', completed_at = now()
      where id = ${dueSoon.id}`

    expect(await alertDueSoonDeletions(now)).toEqual([])
  })

  it('alerts on the next run when every alert of a request failed to queue', async () => {
    const now = new Date(BASE_NOW + 3)
    const { user: admin } = await createTrackedStaff('admin')
    const dueSoon = await openRequestDue(now, 3)
    const spy = vi
      .spyOn(notificationJob, 'addNotificationJob')
      .mockRejectedValue(new Error('Redis unreachable'))

    expect(await alertDueSoonDeletions(now)).toEqual([])
    spy.mockRestore()

    expect(await alertDueSoonDeletions(now)).toEqual([dueSoon.id])
    expect(await waitForNotice(admin.id, dueSoon.id)).toHaveLength(1)
  })
})
