/**
 * @file Auth mail in `full` maintenance: reconciling an old `full` pauses
 * every queue but `auth-email`, a staff member's sign-in link still reaches
 * `sent` while the `email` queue is paused, and a non-staff address gets the
 * same 202 and no mail. The file runs its own `auth-email` Worker;
 * `createApp()` starts none.
 */
import { randomUUID } from 'node:crypto'
import type { Worker } from 'bullmq'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { EmailJobData } from '@/jobs/email.job'
import { sql } from '@/services/database.service'
import {
  reconcileQueuePause,
  setAllQueuesPaused,
} from '@/services/maintenance-mode/maintenance-mode-queues.service'
import {
  getMaintenanceMode,
  reloadMaintenanceMode,
} from '@/services/maintenance-mode/maintenance-mode-store.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getPausableQueues,
} from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { requestSignInLink } from '@/services/sign-in-link.service'
import { startEmailWorker } from '@/workers/email.worker'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../../helpers/maintenance-mode'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'
import { request } from '../../../helpers/request'
import { waitUntil } from '../../../helpers/timing'

const app = createApp()

/**
 * The Worker for the queue the pause leaves running.
 */
const worker: Worker<EmailJobData> = startEmailWorker('auth-email')

/**
 * The fixed 202 body `POST /auth/link/request` answers every address with.
 */
const REQUEST_ACCEPTED_BODY = {
  success: true,
  message: 'Check your inbox for a sign-in link.',
  statusCode: 202,
  // eslint-disable-next-line unicorn/no-null -- the envelope's JSON null for "no data"
  data: null,
}

/**
 * Every address this file used, lowercased, for `afterEach` to delete its rows.
 */
const usedEmails: string[] = []

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `auth-mail-full-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * The statuses of the `sign_in_link` messages one address was sent.
 * @param email - The address.
 * @returns One status per message.
 */
async function messageStatuses(email: string): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    select status from email_messages
    where recipient = ${email.toLowerCase()} and template_key = 'sign_in_link'
  `
  return rows.map((row) => row.status)
}

/**
 * Delete every key of the link request limiter, so its IP budget does not carry between tests.
 */
async function clearRequestLimiter(): Promise<void> {
  const client = await getRedis()
  const keys: string[] = []
  const batches = client.scanIterator({ MATCH: `${redisKey('rl', 'sign-in-link-request')}:*` })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await client.del(keys)
}

/**
 * Store `full`, changed a minute ago so the pause grace is over, load it and reconcile the queues.
 */
async function enterFullPastGrace(): Promise<void> {
  await storeMaintenanceMode('full', { changedAt: new Date(Date.now() - 60_000) })
  await reloadMaintenanceMode()
  await reconcileQueuePause(getMaintenanceMode())
}

beforeEach(async () => {
  await clearRequestLimiter()
  await enterFullPastGrace()
})

afterEach(async () => {
  await setAllQueuesPaused(false)
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

afterAll(async () => {
  await setAllQueuesPaused(false)
  await worker.close()
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

describe('auth mail during full maintenance', () => {
  it('pauses every queue but auth-email in full', async () => {
    const pausable = await Promise.all(getPausableQueues().map((queue) => queue.isPaused()))

    expect(pausable).toEqual([true, true, true, true])
    expect(await getAuthEmailQueue().isPaused()).toBe(false)
  })

  it('delivers a sign-in link to a staff member while full has the queues paused', async () => {
    const { user } = await createTrackedStaff('viewer', { email: uniqueEmail('staff') })

    const response = await request(app)
      .post('/api/v1/auth/link/request')
      .send({ email: user.email, app: 'apex' })

    expect(response.status).toBe(202)
    expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
    await waitUntil(
      async () => {
        const statuses = await messageStatuses(user.email)
        return statuses.includes('sent') || undefined
      },
      { message: 'the staff sign-in link to reach sent' }
    )
    expect(await getEmailQueue().isPaused()).toBe(true)
  })

  it('mails nothing to a non-staff address in full and answers the same 202', async () => {
    const customer = await createTrackedUser({ email: uniqueEmail('customer') })
    const unknown = uniqueEmail('unknown')

    for (const email of [customer.email, unknown]) {
      const response = await request(app).post('/api/v1/auth/link/request').send({ email })
      expect(response.status).toBe(202)
      expect(response.body).toEqual(REQUEST_ACCEPTED_BODY)
      // The follow-up the request ran after replying, awaited here so its absence of mail is final.
      await requestSignInLink({ email, app: 'web' })()
      expect(await messageStatuses(email)).toEqual([])
    }
  })
})
