/**
 * @file POST /platform/tenants/:id/onboarding/steps/:key/complete and
 * POST /platform/tenants/:id/onboarding/remind. Each refusal's 409 code,
 * the audit entry filed in the target tenant with platform access, and,
 * for a reminder, one email job per active owner with its `email_messages`
 * row (template `onboarding_reminder`, the tenant's id) and the 24-hour
 * limit read from the latest audit entry. Mail is asserted on the queue
 * and in `email_messages`, never delivered.
 */
import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { onboardingStepByKey } from '@/constants/onboarding.constants'
import type { EmailJobData } from '@/jobs/email.job'
import { PlatformOnboardingRepository } from '@/repositories/platform-onboarding.repository'
import { sql, type DbTransaction } from '@/services/database.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../helpers/lock-probe'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  addCompletion,
  addMember,
  createOnboardingTenant,
  daysAgo,
  deleteOnboardingTenants,
} from '../../helpers/onboarding'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

interface ApiEnvelope<TData> {
  success: boolean
  message: string
  code?: string
  errors?: Record<string, unknown>
  data?: TData
}

interface AuditRow {
  action: string
  tenant_id: string
  target_type: string
  target_id: string
  access: string
  actor_user_id: string | null
  metadata: Record<string, unknown>
}

interface MessageRow {
  id: string
  recipient: string
  template_key: string
  tenant_id: string | null
  user_id: string | null
  sender_class: string
  variables: Record<string, string>
}

const app = createApp()
const byText = (a: string, b: string): number => a.localeCompare(b)
const REASON = 'Agreed on the onboarding call'
// A test that waits on a lock gets room for the probe's own 5-second deadline.
const LOCK_WAIT_TIMEOUT_MS = 10_000

function post(token: string, path: string, body?: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body ?? { reason: REASON })
}

function complete(token: string, tenantId: string, stepKey: string, body?: object) {
  return post(token, `/tenants/${tenantId}/onboarding/steps/${stepKey}/complete`, body)
}

function remind(token: string, tenantId: string, body?: object) {
  return post(token, `/tenants/${tenantId}/onboarding/remind`, body)
}

/**
 * A reminder request already on the wire: supertest sends only once awaited.
 * @param token - The staff bearer token.
 * @param tenantId - The tenant.
 * @returns The response.
 */
async function sentNow(token: string, tenantId: string): Promise<Response> {
  return await remind(token, tenantId)
}

function codeOf(response: Response): string | undefined {
  return (response.body as ApiEnvelope<unknown>).code
}

async function auditRows(tenantId: string, action: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, tenant_id, target_type, target_id, access, actor_user_id, metadata
    from audit_logs where tenant_id = ${tenantId} and action = ${action}
    order by occurred_at, id
  `
}

async function messagesFor(tenantId: string): Promise<MessageRow[]> {
  return sql<MessageRow[]>`
    select id, recipient, template_key, tenant_id, user_id, sender_class, variables
    from email_messages where tenant_id = ${tenantId} order by recipient
  `
}

async function reminderJobsFor(tenantId: string): Promise<EmailJobData[]> {
  const rows = await messagesFor(tenantId)
  const ids = new Set(rows.map((row) => row.id))
  const jobs = await queuedJobs<EmailJobData>(getEmailQueue())
  return jobs
    .map((job) => job.data)
    .filter((data) => data.messageId !== undefined && ids.has(data.messageId))
}

/**
 * Insert one `onboarding.reminder_sent` entry at a chosen time.
 * @param tenantId - The tenant it is filed in.
 * @param actorId - The staff member.
 * @param occurredAt - When it was sent.
 * @returns Resolves once it is in.
 */
async function addReminderEntry(tenantId: string, actorId: string, occurredAt: Date) {
  await sql`
    insert into audit_logs (actor_kind, actor_user_id, access, tenant_id, action, target_type, target_id, metadata, occurred_at)
    values ('user', ${actorId}, 'platform', ${tenantId}, 'onboarding.reminder_sent', 'tenant', ${tenantId},
      ${JSON.stringify({ reason: 'Earlier nudge', recipientCount: 1, emailDomains: [], messageIds: [] })}::jsonb,
      ${occurredAt.toISOString()}::timestamptz)
  `
}

afterEach(async () => {
  await truncateAuditLogs()
  await deleteOnboardingTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await closeQueue()
})

describe('POST /platform/tenants/:id/onboarding/steps/:key/complete', () => {
  it('records a staff completion with the reason, audited in the tenant with platform access', async () => {
    const { user: staff, token } = await createTrackedStaff('admin', {
      firstName: 'Ada',
      lastName: 'Admin',
    })
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })

    const response = await complete(token, tenant.id, 'configure_settings')

    expect(response.status).toBe(200)
    const detail = (
      response.body as ApiEnvelope<{ steps: { key: string; source: string; reason: string }[] }>
    ).data
    expect(detail?.steps[0]).toMatchObject({
      key: 'configure_settings',
      source: 'staff',
      completedBy: { id: staff.id, name: 'Ada Admin' },
      reason: REASON,
    })
    const [row] = await sql<{ source: string; completed_by: string; reason: string }[]>`
      select source, completed_by, reason from onboarding_completions
      where tenant_id = ${tenant.id} and step_key = 'configure_settings'
    `
    expect(row).toEqual({ source: 'staff', completed_by: staff.id, reason: REASON })
    expect(await auditRows(tenant.id, 'onboarding.step_completed')).toEqual([
      {
        action: 'onboarding.step_completed',
        tenant_id: tenant.id,
        target_type: 'tenant',
        target_id: tenant.id,
        access: 'platform',
        actor_user_id: staff.id,
        metadata: { reason: REASON, stepKey: 'configure_settings' },
      },
    ])
  })

  it('still records on a dismissed tenant', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({
      startedAt: daysAgo(3),
      dismissedAt: daysAgo(1),
    })

    const response = await complete(token, tenant.id, 'invite_teammate')

    expect(response.status).toBe(200)
    expect(await auditRows(tenant.id, 'onboarding.step_completed')).toHaveLength(1)
  })

  it('answers 409 member_step for a member step', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant()

    const response = await complete(token, tenant.id, 'read_getting_started')

    expect(response.status).toBe(409)
    expect(codeOf(response)).toBe('member_step')
  })

  it('answers 409 already_complete for a step already done, writing no second entry', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant()
    await addCompletion(tenant.id, 'invite_teammate')

    const response = await complete(token, tenant.id, 'invite_teammate')

    expect(response.status).toBe(409)
    expect(codeOf(response)).toBe('already_complete')
    expect(await auditRows(tenant.id, 'onboarding.step_completed')).toEqual([])
  })

  it('answers 409 not_tracked for an untracked tenant and one awaiting its owner', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant: untracked } = await createOnboardingTenant({ isTracked: false })
    // eslint-disable-next-line unicorn/no-null -- awaiting the first owner
    const { tenant: awaiting } = await createOnboardingTenant({ startedAt: null })

    for (const tenant of [untracked, awaiting]) {
      const response = await complete(token, tenant.id, 'configure_settings')
      expect({ id: tenant.id, status: response.status, code: codeOf(response) }).toEqual({
        id: tenant.id,
        status: 409,
        code: 'not_tracked',
      })
    }
  })

  it.each(['suspended', 'archived'] as const)(
    'answers 409 tenant_state_conflict for a %s tenant',
    async (lifecycleState) => {
      const { token } = await createTrackedStaff('admin')
      const { tenant } = await createOnboardingTenant({ lifecycleState })

      const response = await complete(token, tenant.id, 'configure_settings')

      expect(response.status).toBe(409)
      expect(codeOf(response)).toBe('tenant_state_conflict')
      expect(await auditRows(tenant.id, 'onboarding.step_completed')).toEqual([])
    }
  )

  it('answers 404 for an unknown step, an unknown tenant and the platform tenant', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant()
    const platform = await platformTenant()

    const unknownStep = await complete(token, tenant.id, 'no_such_step')
    const unknownTenant = await complete(token, randomUUID(), 'configure_settings')
    const platformStep = await complete(token, platform.id, 'configure_settings')

    expect(unknownStep.status).toBe(404)
    expect((unknownStep.body as ApiEnvelope<unknown>).message).toBe('Onboarding step not found')
    expect(codeOf(unknownStep)).toBe('onboarding_step_not_found')
    expect([unknownTenant.status, platformStep.status]).toEqual([404, 404])
  })

  it('answers 400 without a reason, or with another field', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant()

    const missing = await complete(token, tenant.id, 'configure_settings', {})
    const extra = await complete(token, tenant.id, 'configure_settings', {
      reason: REASON,
      source: 'auto',
    })

    expect([missing.status, extra.status]).toEqual([400, 400])
  })
})

describe('POST /platform/tenants/:id/onboarding/remind', () => {
  it('queues one reminder per active owner, tracked in email_messages, and audits the message ids', async () => {
    const { user: staff, token } = await createTrackedStaff('admin')
    const { tenant, owner } = await createOnboardingTenant({
      startedAt: daysAgo(10),
      name: 'Acme Rockets',
    })
    const secondOwner = await addMember(tenant, 'owner')
    await addMember(tenant, 'owner', { isActive: false })
    await addMember(tenant, 'editor')

    const response = await remind(token, tenant.id)

    expect(response.status).toBe(200)
    expect((response.body as ApiEnvelope<unknown>).data).toEqual({
      emailSent: true,
      recipientCount: 2,
    })
    const messages = await messagesFor(tenant.id)
    expect(messages.map((row) => row.recipient).toSorted(byText)).toEqual(
      [owner.email, secondOwner.email].toSorted(byText)
    )
    for (const message of messages) {
      expect(message).toMatchObject({
        template_key: 'onboarding_reminder',
        tenant_id: tenant.id,
        sender_class: 'general',
        variables: {
          tenantName: 'Acme Rockets',
          appName: getEnv().APP_NAME,
          nextStep: onboardingStepByKey('configure_settings')?.title,
          overviewLink: `${getEnv().WEB_URL.replace(/\/$/, '')}/tenants/${tenant.slug}`,
        },
      })
    }
    const jobs = await reminderJobsFor(tenant.id)
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.templateKey === 'onboarding_reminder')).toBe(true)
    const [entry] = await auditRows(tenant.id, 'onboarding.reminder_sent')
    expect(entry).toMatchObject({
      target_type: 'tenant',
      target_id: tenant.id,
      access: 'platform',
      actor_user_id: staff.id,
      metadata: { reason: REASON, recipientCount: 2, emailDomains: ['example.test'] },
    })
    expect((entry?.metadata.messageIds as string[]).toSorted(byText)).toEqual(
      messages.map((row) => row.id).toSorted(byText)
    )
    expect(JSON.stringify(entry?.metadata)).not.toContain('@')
  })

  it('names the next required step in the reminder', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(1) })
    await addCompletion(tenant.id, 'configure_settings')

    await remind(token, tenant.id)

    const [message] = await messagesFor(tenant.id)
    expect(message?.variables.nextStep).toBe(onboardingStepByKey('invite_teammate')?.title)
  })

  it('answers 409 reminded_recently within 24 hours of the last reminder, with retryAfter', async () => {
    const { user: staff, token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const lastAt = new Date(Date.now() - 23 * 60 * 60 * 1000)
    await addReminderEntry(tenant.id, staff.id, lastAt)

    const response = await remind(token, tenant.id)

    expect(response.status).toBe(409)
    expect(codeOf(response)).toBe('reminded_recently')
    expect((response.body as ApiEnvelope<unknown>).errors).toEqual({
      retryAfter: new Date(lastAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(await messagesFor(tenant.id)).toEqual([])
  })

  it('refuses a second reminder straight after the first', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })

    const first = await remind(token, tenant.id)
    const second = await remind(token, tenant.id)

    expect([first.status, second.status]).toEqual([200, 409])
    expect(codeOf(second)).toBe('reminded_recently')
    expect(await messagesFor(tenant.id)).toHaveLength(1)
  })

  it('allows a reminder once 24 hours have passed', async () => {
    const { user: staff, token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    await addReminderEntry(tenant.id, staff.id, new Date(Date.now() - 25 * 60 * 60 * 1000))

    const response = await remind(token, tenant.id)

    expect(response.status).toBe(200)
    expect(await auditRows(tenant.id, 'onboarding.reminder_sent')).toHaveLength(2)
  })

  it('answers 409 no_owner when the only owner is deactivated', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant, owner } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    await sql`update users set active = false where id = ${owner.id}`

    const response = await remind(token, tenant.id)

    expect(response.status).toBe(409)
    expect(codeOf(response)).toBe('no_owner')
  })

  it('answers 409 not_in_progress for a complete, dismissed, awaiting or untracked tenant', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant: complete } = await createOnboardingTenant({ startedAt: daysAgo(3) })
    await addCompletion(complete.id, 'configure_settings')
    await addCompletion(complete.id, 'invite_teammate')
    const { tenant: dismissed } = await createOnboardingTenant({
      startedAt: daysAgo(3),
      dismissedAt: daysAgo(1),
    })
    // eslint-disable-next-line unicorn/no-null -- awaiting the first owner
    const { tenant: awaiting } = await createOnboardingTenant({ startedAt: null })
    const { tenant: untracked } = await createOnboardingTenant({ isTracked: false })

    for (const tenant of [complete, dismissed, awaiting, untracked]) {
      const response = await remind(token, tenant.id)
      expect({ id: tenant.id, status: response.status, code: codeOf(response) }).toEqual({
        id: tenant.id,
        status: 409,
        code: 'not_in_progress',
      })
    }
  })

  it.each(['suspended', 'archived'] as const)(
    'answers 409 tenant_state_conflict for a %s tenant, queueing nothing',
    async (lifecycleState) => {
      const { token } = await createTrackedStaff('admin')
      const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10), lifecycleState })

      const response = await remind(token, tenant.id)

      expect(response.status).toBe(409)
      expect(codeOf(response)).toBe('tenant_state_conflict')
      expect(await messagesFor(tenant.id)).toEqual([])
    }
  )

  it('answers 404 for an unknown tenant and the platform tenant, 400 without a reason', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const platform = await platformTenant()

    const unknown = await remind(token, randomUUID())
    const platformRemind = await remind(token, platform.id)
    const noReason = await remind(token, tenant.id, {})

    expect([unknown.status, platformRemind.status, noReason.status]).toEqual([404, 404, 400])
  })

  it('shows the reminder in the tenant tab history, linked to its messages', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })

    await remind(token, tenant.id)
    const detail = await request(app)
      .get(`/api/v1/platform/tenants/${tenant.id}/onboarding`)
      .set('Authorization', `Bearer ${token}`)

    const body = (
      detail.body as ApiEnvelope<{
        reminders: { messageIds: string[] }[]
        reminder: { blockedBy: string }
      }>
    ).data
    const messages = await messagesFor(tenant.id)
    expect(body?.reminders[0]?.messageIds).toEqual(messages.map((row) => row.id))
    expect(body?.reminder.blockedBy).toBe('reminded_recently')
  })

  it('previews the reminder through the staff email preview, link shown', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    await remind(token, tenant.id)
    const [message] = await messagesFor(tenant.id)

    const preview = await request(app)
      .get(`/api/v1/platform/emails/${message?.id ?? ''}/preview`)
      .set('Authorization', `Bearer ${token}`)

    expect(preview.status).toBe(200)
    const body = (preview.body as ApiEnvelope<{ text: string; partial: boolean }>).data
    expect(body?.partial).toBe(false)
    expect(body?.text).toContain(`/tenants/${tenant.slug}`)
  })

  it(
    "makes a second reminder wait on the first one's tenant lock, then refuses it reminded_recently",
    async () => {
      const { token } = await createTrackedStaff('admin')
      const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
      await addMember(tenant, 'owner')

      // Pause the first reminder in its transaction, tenant row held, before it reads the limit (pool of 2).
      const reached = deferred<number>()
      const release = deferred()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realLatest = PlatformOnboardingRepository.prototype.latestReminderAt
      let calls = 0
      const pausingLatest: typeof realLatest = async function (
        this: PlatformOnboardingRepository,
        ...arguments_
      ) {
        calls += 1
        if (calls === 1) {
          reached.resolve(await backendPid(arguments_[1] as DbTransaction))
          await release.promise
        }
        return realLatest.apply(this, arguments_)
      }

      let responses: Response[] = []
      await withMutatedMethod(
        PlatformOnboardingRepository.prototype,
        'latestReminderAt',
        pausingLatest,
        async () => {
          const first = sentNow(token, tenant.id)
          const firstPid = await untilSignalled(reached.promise, first, 'first reminder')
          const second = sentNow(token, tenant.id)
          // Both hold the actor's rows FOR SHARE, so the tenant row is the only lock it can queue on.
          expect(await waitForWaiter(firstPid, second)).toBe(true)
          release.resolve()
          responses = await Promise.all([first, second])
        }
      )

      expect(responses.map((response) => response.status)).toEqual([200, 409])
      expect(responses[1] && codeOf(responses[1])).toBe('reminded_recently')
      expect(await auditRows(tenant.id, 'onboarding.reminder_sent')).toHaveLength(1)
      expect(await messagesFor(tenant.id)).toHaveLength(2)
      expect(await reminderJobsFor(tenant.id)).toHaveLength(2)
    },
    LOCK_WAIT_TIMEOUT_MS
  )

  it('sends reminders to two tenants at once, within the test pool', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant: first } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const { tenant: second } = await createOnboardingTenant({ startedAt: daysAgo(10) })

    const responses = await Promise.all([remind(token, first.id), remind(token, second.id)])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await reminderJobsFor(first.id)).toHaveLength(1)
    expect(await reminderJobsFor(second.id)).toHaveLength(1)
  })

  it('keeps the entry and answers emailSent false when a job cannot be enqueued after commit', async () => {
    const { token } = await createTrackedStaff('admin')
    const { tenant } = await createOnboardingTenant({ startedAt: daysAgo(10) })
    const addUnavailable = (() => Promise.reject(new Error('unavailable'))) as Queue['add']

    let status: number | undefined
    let data: unknown
    await withMutatedMethod(Queue.prototype, 'add', addUnavailable, async () => {
      const response = await remind(token, tenant.id)
      status = response.status
      data = (response.body as ApiEnvelope<unknown>).data
    })

    expect(status).toBe(200)
    expect(data).toEqual({
      emailSent: false,
      recipientCount: 1,
    })
    const [message] = await sql<{ id: string; status: string; failure_origin: string }[]>`
      select id, status, failure_origin from email_messages where tenant_id = ${tenant.id}
    `
    expect(message).toMatchObject({ status: 'failed', failure_origin: 'enqueue' })
    const [entry] = await auditRows(tenant.id, 'onboarding.reminder_sent')
    expect(entry?.metadata.messageIds).toEqual([message?.id])
  })
})
