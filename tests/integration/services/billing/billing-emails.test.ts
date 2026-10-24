/**
 * @file The billing emails a committed change sends, through
 * `emitBillingDiff` and the sync: who gets each one (owners once each, the
 * billing address when it is not an owner's, the requester alone for a
 * fulfilled upgrade request), that each transition sends once and a re-run
 * of the same change sends nothing even after the first mail went out, that
 * the payment failure reaches owners as a notification carrying its email,
 * dates in the workspace's time zone, and that a failed send never fails the
 * change. No worker runs: the test reads the `email_messages` rows and the
 * queued jobs, and runs a notification job through its processor by hand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type { User } from '@/database/models/user.model'
import type { NotificationJobData } from '@/jobs/notification.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { NotificationPreferenceRepository } from '@/repositories/notification-preference.repository'
import { emitBillingDiff } from '@/services/billing/billing-events.service'
import { runFrequentBilling } from '@/services/billing/billing-scheduler.service'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { cancelPaid } from '@/services/billing/checkout.service'
import { sql } from '@/services/database.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { processNotificationJob } from '@/workers/notification.worker'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  plans,
  readBilling,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import { withMutatedMethod } from '../../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  return fakeProviderModule()
})

const billingRepository = new BillingRepository()
const preferenceRepository = new NotificationPreferenceRepository()

const PERIOD_END = new Date('2026-11-01T20:00:00.000Z')

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * A workspace with two owners, a viewer and a billing address no owner has.
 * @returns The workspace's id, its people and its billing row.
 */
async function team(): Promise<{
  tenantId: string
  owner: User
  coOwner: User
  viewer: User
  row: TenantBillingRecord
}> {
  const { tenant, owner } = await workspace()
  const coOwner = await createTrackedUser()
  const viewer = await createTrackedUser()
  await sql`insert into user_memberships (user_id, tenant_id, role) values (${coOwner.id}, ${tenant.id}, 'owner'), (${viewer.id}, ${tenant.id}, 'viewer')`
  await setBilling(tenant.id, { billingEmail: 'accounts@example.test' })
  return { tenantId: tenant.id, owner, coOwner, viewer, row: await readBilling(tenant.id) }
}

/**
 * The row paying monthly on a subscription, as a sync would write it.
 * @param row - The row before.
 * @returns The row after.
 */
function paidFrom(row: TenantBillingRecord): TenantBillingRecord {
  return {
    ...row,
    state: 'active',
    planId: plans.paidId,
    priceId: plans.monthPriceId,
    providerSubscriptionId: 'sub_FAKEwelcome',
    currentPeriodEnd: PERIOD_END,
    version: row.version + 1,
  }
}

/**
 * One workspace's mail of one template, by recipient.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns Each message's recipient, user, status and stored variables.
 */
async function mailsOf(
  tenantId: string,
  templateKey: string
): Promise<
  { recipient: string; userId: string | null; status: string; variables: Record<string, string> }[]
> {
  return sql<
    {
      recipient: string
      userId: string | null
      status: string
      variables: Record<string, string>
    }[]
  >`select recipient, user_id as "userId", status, variables from email_messages where tenant_id = ${tenantId} and template_key = ${templateKey} order by recipient`
}

/**
 * The recipients of one workspace's mail of one template, sorted.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns The addresses.
 */
async function recipientsOf(tenantId: string, templateKey: string): Promise<string[]> {
  const mails = await mailsOf(tenantId, templateKey)
  return mails.map((mail) => mail.recipient).toSorted()
}

/**
 * The stored variables of one workspace's first mail of one template.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns The variables, or undefined when there is no mail.
 */
async function variablesOf(
  tenantId: string,
  templateKey: string
): Promise<Record<string, string> | undefined> {
  const [first] = await mailsOf(tenantId, templateKey)
  return first?.variables
}

/**
 * Mark every message of a workspace sent and empty the queues, as if the
 * worker had sent them and BullMQ had removed the completed jobs.
 * @param tenantId - The workspace.
 */
async function deliverAll(tenantId: string): Promise<void> {
  await sql`update email_messages set status = 'sent' where tenant_id = ${tenantId}`
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
}

describe('billing emails', () => {
  it('mails each owner once and the billing address when it is no owner’s, never a viewer', async () => {
    const { tenantId, owner, coOwner, row } = await team()

    await emitBillingDiff(row, paidFrom(row), 'webhook')

    const mails = await mailsOf(tenantId, 'paid_welcome')
    expect(mails.map((mail) => mail.recipient).toSorted()).toEqual(
      ['accounts@example.test', owner.email, coOwner.email].toSorted()
    )
    expect(mails.find((mail) => mail.recipient === owner.email)?.userId).toBe(owner.id)
    expect(mails.find((mail) => mail.recipient === 'accounts@example.test')?.userId).toBeNull()
    expect(mails[0]?.variables).toMatchObject({
      amount: '999',
      interval: 'month',
      nextChargeOn: '1 November 2026',
    })
    const jobs = await queuedJobs<{ templateKey: string }>(getEmailQueue())
    expect(jobs.filter((job) => job.data.templateKey === 'paid_welcome')).toHaveLength(3)
  })

  it('mails an owner once when the billing address is theirs in another case', async () => {
    const { tenantId, owner, row } = await team()
    const sameAsOwner = { ...row, billingEmail: owner.email.toUpperCase() }

    await emitBillingDiff(sameAsOwner, paidFrom(sameAsOwner), 'webhook')

    const recipients = await recipientsOf(tenantId, 'paid_welcome')
    expect(recipients.filter((recipient) => recipient === owner.email)).toHaveLength(1)
    expect(recipients).toHaveLength(2)
  })

  it('sends each transition once, and nothing for a re-run after the mail went out', async () => {
    const { tenantId, row } = await team()
    const paid = paidFrom(row)

    await emitBillingDiff(row, paid, 'webhook')
    await emitBillingDiff(row, paid, 'webhook')
    expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(3)
    expect(await queuedJobs(getEmailQueue())).toHaveLength(3)

    await deliverAll(tenantId)
    await emitBillingDiff(row, paid, 'reconcile')

    const mails = await mailsOf(tenantId, 'paid_welcome')
    expect(mails).toHaveLength(3)
    expect(mails.every((mail) => mail.status === 'sent')).toBe(true)
    expect(await queuedJobs(getEmailQueue())).toHaveLength(0)
  })

  it('sends nothing for a write that repeats the same state', async () => {
    const { tenantId, row } = await team()
    const paid = paidFrom(row)

    await emitBillingDiff(paid, { ...paid, version: paid.version + 1 }, 'reconcile')

    const rows = await sql`select id from email_messages where tenant_id = ${tenantId}`
    expect(rows).toHaveLength(0)
  })

  it('tells owners of a payment failure by notification carrying the email, once', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    const pastDue = { ...paidFrom(row), state: 'past_due' as const, pastDueSince: PERIOD_END }
    const halted = { ...pastDue, haltedAt: PERIOD_END, version: pastDue.version + 1 }

    await emitBillingDiff(pastDue, halted, 'webhook')
    await emitBillingDiff(pastDue, halted, 'webhook')

    // The billing address has no account, so it gets the email directly; owners get it through the notification.
    const direct = await mailsOf(tenantId, 'payment_failed')
    expect(direct.map((mail) => mail.recipient)).toEqual(['accounts@example.test'])
    expect(direct[0]?.variables).toMatchObject({ amount: '999', graceEndsOn: '8 November 2026' })
    const notices = await queuedJobs<NotificationJobData>(getNotificationQueue())
    expect(notices.map((job) => job.data.userId).toSorted()).toEqual(
      [owner.id, coOwner.id].toSorted()
    )
    expect(notices[0]?.data).toMatchObject({
      type: 'billing_payment_failed',
      title: 'Your payment of ₹999 failed',
      email: { templateKey: 'payment_failed' },
    })

    for (const job of notices) await processNotificationJob(job)
    expect(await recipientsOf(tenantId, 'payment_failed')).toEqual(
      ['accounts@example.test', owner.email, coOwner.email].toSorted()
    )
    const inApp =
      await sql`select id from notifications where user_id = any(${[owner.id, coOwner.id]}) and type = 'billing_payment_failed'`
    expect(inApp).toHaveLength(2)

    // The same halt again, after every mail went out: a new notification job runs, and adds nothing.
    await deliverAll(tenantId)
    await emitBillingDiff(pastDue, halted, 'reconcile')
    const again = await queuedJobs<NotificationJobData>(getNotificationQueue())
    for (const job of again) await processNotificationJob(job)
    expect(await mailsOf(tenantId, 'payment_failed')).toHaveLength(3)
    expect(await queuedJobs(getEmailQueue())).toHaveLength(0)
    const inAppAgain =
      await sql`select id from notifications where user_id = any(${[owner.id, coOwner.id]}) and type = 'billing_payment_failed'`
    expect(inAppAgain).toHaveLength(2)
    await sql`delete from notifications where user_id = any(${[owner.id, coOwner.id]})`
  })

  it('starts the billing notices with both channels on, and keeps their email on', async () => {
    const { owner } = await team()
    expect(
      await preferenceRepository.isChannelEnabled(owner.id, 'billing_payment_failed', 'email')
    ).toBe(true)
    expect(await preferenceRepository.isChannelEnabled(owner.id, 'workspace_full', 'in_app')).toBe(
      true
    )
    await expect(
      preferenceRepository.upsert(owner.id, 'billing_payment_failed', {
        emailEnabled: false,
        inAppEnabled: true,
      })
    ).rejects.toMatchObject({ statusCode: 400 })
    await preferenceRepository.upsert(owner.id, 'billing_payment_failed', {
      emailEnabled: true,
      inAppEnabled: false,
    })
    expect(
      await preferenceRepository.isChannelEnabled(owner.id, 'billing_payment_failed', 'in_app')
    ).toBe(false)
    await sql`delete from notification_preferences where user_id = ${owner.id}`
  })

  it('says why a workspace moved to Free, and sends the trial summary when a trial ends', async () => {
    const { tenantId, row } = await team()
    const halted = {
      ...paidFrom(row),
      state: 'past_due' as const,
      pastDueSince: PERIOD_END,
      haltedAt: PERIOD_END,
    }
    const free = { ...row, version: halted.version + 1 }

    await emitBillingDiff(halted, free, 'job')
    expect(await variablesOf(tenantId, 'moved_to_free')).toMatchObject({
      downgradeCause: 'payment_failed',
    })

    const trialing = { ...row, state: 'trialing' as const, planId: plans.paidId }
    await emitBillingDiff(trialing, { ...free, version: free.version + 1 }, 'job')
    const ended = await mailsOf(tenantId, 'trial_ended')
    expect(ended).toHaveLength(3)
    // Three people (two owners and a viewer) in a workspace Free allows three.
    expect(ended[0]?.variables.summary).toContain(
      'These Paid features are off: Workspace insights.'
    )
    expect(await mailsOf(tenantId, 'moved_to_free')).toHaveLength(3)
  })

  it("writes billing dates in the workspace's time zone", async () => {
    const { tenantId, row } = await team()
    await sql`update tenant_settings set timezone = 'Asia/Kolkata' where tenant_id = ${tenantId}`
    const paid = paidFrom(row)

    await emitBillingDiff(paid, { ...paid, cancelAtPeriodEnd: true }, 'owner')

    const variables = await variablesOf(tenantId, 'paid_cancelled')
    expect(variables?.endsOn).toBe('2 November 2026')
  })

  it('confirms an interval switch once the next subscription is authenticated', async () => {
    const { tenantId, row } = await team()
    const scheduled = {
      ...paidFrom(row),
      nextSubscriptionId: 'sub_FAKEnext',
      nextPriceId: plans.yearPriceId,
    }

    await emitBillingDiff(scheduled, { ...scheduled, nextAuthenticatedAt: PERIOD_END }, 'webhook')

    expect(await variablesOf(tenantId, 'interval_switch_scheduled')).toMatchObject({
      interval: 'year',
      amount: '9,990',
      switchOn: '1 November 2026',
    })
  })

  it('welcomes the owners and tells the requester alone when a sync makes the workspace Paid', async () => {
    const { tenantId, owner, viewer } = await team()
    const subscriptionId = await fakeSubscription({ tenantId, priceId: plans.monthPriceId })
    await setBilling(tenantId, {
      pendingSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })
    await fake.fakeAdvance(subscriptionId, 'active')
    await billingRepository.openUpgradeRequest({
      tenantId,
      requestedBy: viewer.id,
      surface: 'members',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    await syncTenantBilling(tenantId, 'webhook')

    expect(await readBilling(tenantId)).toHaveProperty('state', 'active')
    expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(3)
    const fulfilled = await mailsOf(tenantId, 'upgrade_request_fulfilled')
    expect(fulfilled.map((mail) => mail.recipient)).toEqual([viewer.email])
    expect(fulfilled[0]?.variables.tenantLink).toContain('/tenants/')
    expect(fulfilled.map((mail) => mail.recipient)).not.toContain(owner.email)
  })

  it("confirms an owner's cancel through the checkout service's own write", async () => {
    const { tenantId, owner } = await team()
    await makePaying(tenantId)

    await cancelPaid({ userId: owner.id }, tenantId)

    expect(await readBilling(tenantId)).toHaveProperty('cancelAtPeriodEnd', true)
    expect(await mailsOf(tenantId, 'paid_cancelled')).toHaveLength(3)
  })

  it('sends the trial summary when the scheduler ends a lapsed trial', async () => {
    const { tenantId } = await team()
    const now = new Date()
    await setBilling(tenantId, {
      state: 'trialing',
      planId: plans.paidId,
      trialEndsAt: new Date(now.getTime() - 60 * 1000),
    })

    await runFrequentBilling(now)
    await runFrequentBilling(now)

    expect(await readBilling(tenantId)).toHaveProperty('state', 'free')
    expect(await mailsOf(tenantId, 'trial_ended')).toHaveLength(3)
    expect(await mailsOf(tenantId, 'moved_to_free')).toHaveLength(0)
  })

  it('never fails the change when a send fails', async () => {
    const { tenantId, row } = await team()
    await withMutatedMethod(
      EmailMessageRepository.prototype,
      'createQueued',
      () => Promise.reject(new Error('probe: the insert failed')),
      async () => {
        await expect(emitBillingDiff(row, paidFrom(row), 'webhook')).resolves.toBeUndefined()
      }
    )
    expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(0)
  })
})
