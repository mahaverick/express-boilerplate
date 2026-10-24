/**
 * @file Billing across a workspace's lifecycle, against this worker's
 * database and the fake provider in Redis: a suspend or archive queues a
 * prompt cancel job besides the 15-minute run; a purge is refused while a
 * subscription runs and cascades the billing row once it has ended; a
 * reactivated workspace hears the warnings its suspension held back, once;
 * and the payer's leaving, deletion, purge and demotion. No worker runs: the
 * test runs billing jobs through the processor and reads the queued
 * notification jobs and the `email_messages` rows.
 */
import type { Job } from 'bullmq'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import type { User } from '@/database/models/user.model'
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_LIFECYCLE_CANCEL_JOB,
  type BillingLifecycleCancelJobData,
} from '@/jobs/billing.job'
import type { NotificationJobData } from '@/jobs/notification.job'
import { runFrequentBilling } from '@/services/billing/billing-scheduler.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { cancelPaid } from '@/services/billing/checkout.service'
import { sql } from '@/services/database.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { purgeTenant, purgeUser } from '@/services/platform-purge.service'
import { archiveTenant, reactivateTenant, suspendTenant } from '@/services/platform-tenant.service'
import { deleteUser } from '@/services/platform-user.service'
import {
  closeQueue,
  getBillingQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { changeRole, leaveTenant } from '@/services/tenant-membership.service'
import { processBillingJob } from '@/workers/billing.worker'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  confirmBody,
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  plans,
  readBilling,
  setBilling,
  subscriptionStatus,
  workspace,
} from '../../helpers/billing-api'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return fakeProviderModule()
})

const app = createApp()

const PURGE_REFUSAL = "Cancel this tenant's subscription before you purge it."

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  vi.restoreAllMocks()
  paymentsSwitch.on = true
  await getBillingQueue().obliterate({ force: true })
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * A platform admin, as the actor of a lifecycle change.
 * @returns The staff actor.
 */
async function staffAdmin(): Promise<{ userId: string }> {
  const { user } = await createTrackedStaff('admin')
  return { userId: user.id }
}

/**
 * A platform owner, as the actor of a purge.
 * @returns The staff actor.
 */
async function staffOwner(): Promise<{ userId: string }> {
  const { user } = await createTrackedStaff('owner')
  return { userId: user.id }
}

/**
 * The queued prompt cancel jobs.
 * @returns The jobs.
 */
async function lifecycleJobs(): Promise<Job<BillingLifecycleCancelJobData>[]> {
  const jobs = await queuedJobs<BillingLifecycleCancelJobData>(getBillingQueue())
  return jobs.filter((job) => job.name === BILLING_LIFECYCLE_CANCEL_JOB)
}

/**
 * Run every queued prompt cancel job through the billing processor, oldest first.
 * @returns How many ran.
 */
async function runLifecycleJobs(): Promise<number> {
  const queued = await lifecycleJobs()
  const jobs = queued.toSorted((a, b) => a.timestamp - b.timestamp)
  for (const job of jobs) {
    await processBillingJob(job)
    await job.remove()
  }
  return jobs.length
}

/**
 * Run a callback while recording every cancel the fake receives.
 * @param run - The callback.
 * @returns Each cancel's subscription id and whether it was at cycle end.
 */
async function recordingCancels(run: () => Promise<unknown>): Promise<[string, boolean][]> {
  const spy = vi.spyOn(fake, 'cancelSubscription')
  try {
    await run()
    return spy.mock.calls.map(([id, isAtCycleEnd]) => [id, isAtCycleEnd])
  } finally {
    spy.mockRestore()
  }
}

/**
 * Add a member to a workspace.
 * @param tenantId - The workspace.
 * @param role - Their role.
 * @param options - Their name.
 * @param options.firstName - Their first name.
 * @returns The member.
 */
async function addMember(
  tenantId: string,
  role: 'owner' | 'admin' | 'viewer',
  options: { firstName?: string } = {}
): Promise<User> {
  const member = await createTrackedUser(options)
  await sql`insert into user_memberships (user_id, tenant_id, role) values (${member.id}, ${tenantId}, ${role})`
  return member
}

/**
 * The queued notification jobs for one workspace.
 * @param tenantId - The workspace.
 * @param type - The notification type.
 * @returns The jobs.
 */
async function noticeJobsOf(tenantId: string, type: string): Promise<Job<NotificationJobData>[]> {
  const jobs = await queuedJobs<NotificationJobData>(getNotificationQueue())
  return jobs.filter(
    (job) =>
      job.data.type === type &&
      (job.data.metadata as { tenantId?: string } | undefined)?.tenantId === tenantId
  )
}

/**
 * The recipients of one workspace's mail of one template.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns Each message's recipient, sorted.
 */
async function mailsOf(tenantId: string, templateKey: string): Promise<string[]> {
  const rows = await sql<{ recipient: string }[]>`
    select recipient from email_messages
    where tenant_id = ${tenantId} and template_key = ${templateKey}
    order by recipient`
  return rows.map((row) => row.recipient)
}

/**
 * Whether a workspace still has a row in `tenants` and in `tenant_billing`.
 * @param tenantId - The workspace.
 * @returns Both answers.
 */
async function rowsOf(tenantId: string): Promise<{ tenant: boolean; billing: boolean }> {
  const [tenant] = await sql`select 1 from tenants where id = ${tenantId}`
  const [billing] = await sql`select 1 from tenant_billing where tenant_id = ${tenantId}`
  return { tenant: tenant !== undefined, billing: billing !== undefined }
}

/**
 * GET a workspace's billing as `user`.
 * @param user - The caller.
 * @param slug - The workspace slug.
 * @returns The `payer` the read shows.
 */
async function payerShownTo(user: User, slug: string): Promise<unknown> {
  const response = await request(app)
    .get(`/api/v1/tenants/${slug}/billing`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
  expect(response.status).toBe(200)
  return (response.body as { data: { payer: unknown } }).data.payer
}

describe('the prompt cancel after a suspend or archive', () => {
  it('cancels a suspended workspace subscription at its cycle end without waiting for the 15-minute run', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)

    await suspendTenant(await staffAdmin(), tenant.id, 'Support ticket 42')
    const queued = await lifecycleJobs()
    expect(queued.map((job) => job.data)).toStrictEqual([{ tenantId: tenant.id }])
    // Nothing touched the billing row inside the suspend.
    expect(await readBilling(tenant.id)).toMatchObject({ cancelAtPeriodEnd: false })

    const cancels = await recordingCancels(runLifecycleJobs)

    expect(cancels).toStrictEqual([[subscriptionId, true]])
    expect(await subscriptionStatus(subscriptionId)).toBe('active')
    const after = await readBilling(tenant.id)
    expect(after).toMatchObject({ state: 'active', cancelAtPeriodEnd: true })
    expect(after.lifecycleCancelSentAt).not.toBeNull()
  })

  it('cancels an archived workspace subscription now', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)

    await archiveTenant(await staffAdmin(), tenant.id, 'Support ticket 42')
    const cancels = await recordingCancels(runLifecycleJobs)

    expect(cancels).toStrictEqual([[subscriptionId, false]])
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
  })

  it('cancels at cycle end on the next frequent run when the job never ran, and once only', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await suspendTenant(await staffAdmin(), tenant.id, 'Support ticket 42')

    const cancels = await recordingCancels(async () => {
      await runFrequentBilling(new Date())
      // The job lands after the run: the claim stops a second cancel.
      await runLifecycleJobs()
    })

    expect(cancels).toStrictEqual([[subscriptionId, true]])
  })

  it('cancels now when a suspended workspace is archived and both jobs run', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const staff = await staffAdmin()
    await suspendTenant(staff, tenant.id, 'Support ticket 42')
    await runLifecycleJobs()

    await archiveTenant(staff, tenant.id, 'Support ticket 43')
    const cancels = await recordingCancels(runLifecycleJobs)

    expect(cancels).toStrictEqual([[subscriptionId, false]])
    expect(await subscriptionStatus(subscriptionId)).toBe('cancelled')
  })

  it('queues nothing when payments are off', async () => {
    const { tenant } = await workspace()
    paymentsSwitch.on = false

    await suspendTenant(await staffAdmin(), tenant.id, 'Support ticket 42')

    expect(await lifecycleJobs()).toStrictEqual([])
  })

  it('queues no job on a reactivation', async () => {
    const { tenant } = await workspace()
    const staff = await staffAdmin()
    await suspendTenant(staff, tenant.id, 'Support ticket 42')
    await runLifecycleJobs()

    await reactivateTenant(staff, tenant.id, 'Support ticket 43')

    expect(await lifecycleJobs()).toStrictEqual([])
  })
})

describe('the purge of a workspace that pays', () => {
  it('refuses 409 while the subscription runs, and keeps the workspace', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    await archiveTenant(await staffAdmin(), tenant.id, 'Support ticket 42')

    await expect(purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')).rejects.toMatchObject({
      statusCode: 409,
      message: PURGE_REFUSAL,
    })
    expect(await rowsOf(tenant.id)).toStrictEqual({ tenant: true, billing: true })
  })

  it('purges once the archive cancel has run, and the billing row goes with the workspace', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    await archiveTenant(await staffAdmin(), tenant.id, 'Support ticket 42')
    await runLifecycleJobs()

    await purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')

    expect(await rowsOf(tenant.id)).toStrictEqual({ tenant: false, billing: false })
  })

  it('refuses 409 while a checkout or a scheduled switch is still open at the provider', async () => {
    const { tenant } = await workspace()
    const pending = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await setBilling(tenant.id, {
      pendingSubscriptionId: pending,
      provider: 'fake',
      providerMode: 'test',
    })
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`

    await expect(purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')).rejects.toMatchObject({
      statusCode: 409,
      message: PURGE_REFUSAL,
    })
  })

  it('purges a Free workspace that still holds the id of an old cancelled subscription', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await fake.cancelSubscription(subscriptionId, false)
    // As the sync leaves it once the cancelled period and its buffer have passed.
    await setBilling(tenant.id, { state: 'free', planId: plans.freeId, priceId: null })
    await archiveTenant(await staffAdmin(), tenant.id, 'Support ticket 42')

    await purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')

    expect(await rowsOf(tenant.id)).toStrictEqual({ tenant: false, billing: false })
  })

  it('refuses 503 when the provider does not answer, and 502 when it refuses the read', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    // Archived without the cancel job, so the row still pays and the provider must be read.
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    const staff = await staffOwner()
    const read = vi.spyOn(fake, 'fetchSubscription')

    read.mockRejectedValueOnce(new ProviderError(`GET /subscriptions/${subscriptionId}`, 'timeout'))
    await expect(purgeTenant(staff, tenant.id, 'Ticket 42')).rejects.toMatchObject({
      statusCode: 503,
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    })

    read.mockRejectedValueOnce(
      new ProviderError(`GET /subscriptions/${subscriptionId}`, 401, { code: 'UNAUTHORIZED' })
    )
    await expect(purgeTenant(staff, tenant.id, 'Ticket 42')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    })
    expect(await rowsOf(tenant.id)).toStrictEqual({ tenant: true, billing: true })
  })

  it('refuses 502 when payments are off and the workspace still pays', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    paymentsSwitch.on = false

    await expect(purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')).rejects.toMatchObject({
      statusCode: 502,
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
    })
  })

  it('purges a Free workspace with payments off', async () => {
    const { tenant } = await workspace()
    await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenant.id}`
    paymentsSwitch.on = false

    await purgeTenant(await staffOwner(), tenant.id, 'Ticket 42')

    expect(await rowsOf(tenant.id)).toStrictEqual({ tenant: false, billing: false })
  })
})

describe('the warnings a suspension held back', () => {
  it('sends the payment failed notice on reactivation, once', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    const staff = await staffAdmin()
    await suspendTenant(staff, tenant.id, 'Support ticket 42')
    // The payment failed while the workspace was suspended, so no one was told.
    const haltedAt = new Date()
    await setBilling(tenant.id, { state: 'past_due', pastDueSince: haltedAt, haltedAt })

    await reactivateTenant(staff, tenant.id, 'Support ticket 43')
    await suspendTenant(staff, tenant.id, 'Support ticket 44')
    await reactivateTenant(staff, tenant.id, 'Support ticket 45')

    const jobs = await noticeJobsOf(tenant.id, 'billing_payment_failed')
    expect(jobs.map((job) => job.data.userId)).toStrictEqual([owner.id])
    expect(jobs[0]?.data.email?.templateKey).toBe('payment_failed')
  })

  it('tells the owners Paid ends after the suspension cancelled it at the cycle end', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    const staff = await staffAdmin()
    await suspendTenant(staff, tenant.id, 'Support ticket 42')
    await runLifecycleJobs()
    expect(await mailsOf(tenant.id, 'paid_cancelled')).toStrictEqual([])

    await reactivateTenant(staff, tenant.id, 'Support ticket 43')
    await suspendTenant(staff, tenant.id, 'Support ticket 44')
    await runLifecycleJobs()
    await reactivateTenant(staff, tenant.id, 'Support ticket 45')

    expect(await mailsOf(tenant.id, 'paid_cancelled')).toStrictEqual([owner.email])
  })

  it('does not repeat the cancel email an owner already got before the suspension', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    await cancelPaid({ userId: owner.id }, tenant.id)
    expect(await mailsOf(tenant.id, 'paid_cancelled')).toStrictEqual([owner.email])
    const staff = await staffAdmin()
    await suspendTenant(staff, tenant.id, 'Support ticket 42')
    await runLifecycleJobs()

    await reactivateTenant(staff, tenant.id, 'Support ticket 43')

    expect(await mailsOf(tenant.id, 'paid_cancelled')).toStrictEqual([owner.email])
    expect(await noticeJobsOf(tenant.id, 'billing_payment_failed')).toStrictEqual([])
  })
})

describe('the payer', () => {
  it('leaves: the remaining owners get one notice carrying the email, and the read shows them gone', async () => {
    const { tenant, owner } = await workspace()
    const payer = await addMember(tenant.id, 'owner')
    await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: payer.id, billingEmail: payer.email })

    await leaveTenant({ userId: payer.id }, tenant.id)

    const jobs = await noticeJobsOf(tenant.id, 'billing_payer_left')
    expect(jobs.map((job) => job.data.userId)).toStrictEqual([owner.id])
    expect(jobs[0]?.data.email?.templateKey).toBe('payer_left')
    expect(await payerShownTo(owner, tenant.slug)).toMatchObject({
      userId: payer.id,
      isMember: false,
    })
    expect(await readBilling(tenant.id)).toMatchObject({ state: 'active' })
  })

  it('is demoted from owner: they keep paying, no one is told, and the read still shows them a member', async () => {
    const { tenant, owner } = await workspace()
    const payer = await addMember(tenant.id, 'owner')
    await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: payer.id, billingEmail: payer.email })

    // On a customer workspace an owner changes only their own ownership.
    await changeRole({ userId: payer.id }, tenant.id, payer.id, 'admin')

    expect(await noticeJobsOf(tenant.id, 'billing_payer_left')).toStrictEqual([])
    expect(await mailsOf(tenant.id, 'payer_left')).toStrictEqual([])
    expect(await payerShownTo(owner, tenant.slug)).toMatchObject({
      userId: payer.id,
      isMember: true,
    })
    expect(await readBilling(tenant.id)).toMatchObject({
      payerUserId: payer.id,
      billingEmail: payer.email,
    })
  })

  it('becomes another owner once that owner confirms a card change', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: owner.id, billingEmail: owner.email })
    const secondOwner = await addMember(tenant.id, 'owner')
    /**
     * POST a billing path as the second owner.
     * @param path - The path after `/billing/`.
     * @param body - The JSON body.
     * @returns The response.
     */
    const post = (path: string, body: object = {}) =>
      request(app)
        .post(`/api/v1/tenants/${tenant.slug}/billing/${path}`)
        .set('Authorization', `Bearer ${tokenFor(secondOwner)}`)
        .send(body)

    const started = await post('payment-method')
    expect(started.status).toBe(200)
    const confirmed = await post('checkout/confirm', confirmBody(subscriptionId))
    expect(confirmed.status).toBe(200)

    expect(await readBilling(tenant.id)).toMatchObject({
      payerUserId: secondOwner.id,
      billingEmail: secondOwner.email,
    })
  })

  it('is deleted: the payer and billing address are cleared, and the remaining owners are told', async () => {
    const { tenant, owner } = await workspace()
    const payer = await addMember(tenant.id, 'owner')
    await makePaying(tenant.id)
    await setBilling(tenant.id, { payerUserId: payer.id, billingEmail: payer.email })

    await deleteUser(await staffAdmin(), payer.id, 'Asked to be deleted')

    expect(await readBilling(tenant.id)).toMatchObject({ payerUserId: null, billingEmail: null })
    const jobs = await noticeJobsOf(tenant.id, 'billing_payer_left')
    expect(jobs.map((job) => job.data.userId)).toStrictEqual([owner.id])
  })

  it('is purged: the billing address goes with the payer', async () => {
    const { tenant } = await workspace()
    const payer = await createTrackedUser()
    await makePaying(tenant.id)
    // Deleted before the delete cleared the payer, as an older row may be.
    await sql`update users set deleted_at = now() where id = ${payer.id}`
    await setBilling(tenant.id, { payerUserId: payer.id, billingEmail: payer.email })

    await purgeUser(await staffOwner(), payer.id, 'Ticket 42')

    expect(await readBilling(tenant.id)).toMatchObject({ payerUserId: null, billingEmail: null })
  })

  it('is filled from the checkout starter by the sync, with no billing address left behind', async () => {
    const { tenant, owner } = await workspace()
    const subscriptionId = await fakeSubscription({
      tenantId: tenant.id,
      priceId: plans.monthPriceId,
    })
    await setBilling(tenant.id, {
      pendingSubscriptionId: subscriptionId,
      checkoutStartedBy: owner.id,
      payerUserId: null,
      billingEmail: 'earlier-payer@example.test',
    })
    await fake.fakeAdvance(subscriptionId, 'active')

    await syncTenantBilling(tenant.id, 'job')

    expect(await readBilling(tenant.id)).toMatchObject({
      providerSubscriptionId: subscriptionId,
      payerUserId: owner.id,
      billingEmail: null,
    })
  })
})
