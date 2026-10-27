import type { Job } from 'bullmq'
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
import { logger } from '@/services/logger.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import { deleteUser } from '@/services/platform-user.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { leaveTenant, removeMember } from '@/services/tenant-membership.service'
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
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  // The real failure mapping, with the fake as the provider.
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const billingRepository = new BillingRepository()
const preferenceRepository = new NotificationPreferenceRepository()

const PERIOD_END = new Date('2026-11-01T20:00:00.000Z')

beforeAll(async () => {
  await loadPlans()
  // An earlier file in this worker may have left jobs, and the tests count the queues.
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
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
 * The row as a provider-held one: the fake provider in test mode.
 * @param row - The row.
 * @returns The row with its provider set.
 */
function onFake(row: TenantBillingRecord): TenantBillingRecord {
  return { ...row, provider: 'fake', providerMode: 'test' }
}

/**
 * Record, as the billing repository does, that a subscription became a
 * workspace's current one and, when the row moved from another state, the
 * move to active that came with it.
 * @param row - The row that holds the subscription.
 * @param options - When the subscription was first seen and the state it left, if any.
 * @param options.from - The state the row left in that write, or null when it stayed active.
 * @param options.seenAt - When the subscription became current.
 */
async function recordStart(
  row: TenantBillingRecord,
  options: { from: string | null; seenAt: string }
): Promise<void> {
  await sql`insert into tenant_billing_subscriptions (tenant_id, provider, mode, subscription_id, first_seen_at) values (${row.tenantId}, ${row.provider ?? 'fake'}, ${row.providerMode ?? 'test'}, ${row.providerSubscriptionId ?? ''}, ${options.seenAt})`
  if (options.from === null) return
  await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source, at) values (${row.tenantId}, ${options.from}, 'active', 'upgraded', 'webhook', ${options.seenAt}::timestamptz + interval '1 second')`
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
 * Open an upgrade request for a member, valid for a day.
 * @param tenantId - The workspace.
 * @param userId - The member.
 * @returns The request.
 */
async function openRequest(tenantId: string, userId: string) {
  const { request } = await billingRepository.openUpgradeRequest({
    tenantId,
    requestedBy: userId,
    surface: 'members',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  return request
}

/**
 * A member's open upgrade requests in any workspace.
 * @param userId - The member.
 * @returns The ids.
 */
async function openRequestsOf(userId: string): Promise<{ id: string }[]> {
  const rows = await sql<
    { id: string }[]
  >`select id from upgrade_requests where requested_by = ${userId} and fulfilled_at is null`
  return [...rows]
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

  it('welcomes once when the period end arrives in a later sync than the activation', async () => {
    const { tenantId, row } = await team()
    const warn = vi.spyOn(logger, 'warn')
    try {
      const early = { ...onFake(paidFrom(row)), currentPeriodEnd: null }
      const full = { ...early, currentPeriodEnd: PERIOD_END, version: early.version + 1 }
      // The first sync made the subscription current and the row active, as the repository records it.
      await recordStart(early, { from: 'free', seenAt: '2026-10-01T10:00:00Z' })

      await emitBillingDiff(row, early, 'webhook')
      expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(0)

      await emitBillingDiff(early, full, 'webhook')
      await emitBillingDiff(early, full, 'reconcile')

      const mails = await mailsOf(tenantId, 'paid_welcome')
      expect(mails).toHaveLength(3)
      expect(new Set(mails.map((mail) => mail.recipient)).size).toBe(3)
      for (const mail of mails) {
        expect(mail.variables).toMatchObject({ nextChargeOn: '1 November 2026' })
      }
      expect(warn).not.toHaveBeenCalledWith(
        'A billing email had no date or price to send with',
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('sends no welcome for a resubscribe in the cancel buffer, whichever webhook comes first', async () => {
    const { tenantId, row } = await team()
    const warn = vi.spyOn(logger, 'warn')
    try {
      // The row went active long ago and stayed active; the new subscription took over later.
      const cancelling = {
        ...paidFrom(row),
        providerSubscriptionId: 'sub_FAKEold',
        cancelAtPeriodEnd: true,
      }
      const early = {
        ...cancelling,
        providerSubscriptionId: 'sub_FAKEnew',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        version: cancelling.version + 1,
      }
      const full = { ...early, currentPeriodEnd: PERIOD_END, version: early.version + 1 }
      await recordStart(cancelling, { from: 'free', seenAt: '2026-09-01T10:00:00Z' })
      await recordStart(early, { from: null, seenAt: '2026-10-01T10:00:00Z' })

      // The invoice first: the takeover leaves the end empty, the activation fills it.
      await emitBillingDiff(cancelling, early, 'webhook')
      await emitBillingDiff(early, full, 'webhook')
      // The activation first: the takeover already knows the end.
      await emitBillingDiff(cancelling, full, 'reconcile')

      expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(0)
      expect(warn).not.toHaveBeenCalledWith(
        'A billing email had no date or price to send with',
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
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
    const { tenantId, owner, coOwner } = await team()
    await makePaying(tenantId)

    await cancelPaid({ userId: owner.id }, tenantId)

    expect(await readBilling(tenantId)).toHaveProperty('cancelAtPeriodEnd', true)
    expect(await recipientsOf(tenantId, 'paid_cancelled')).toEqual(['accounts@example.test'])
    const notices = await queuedJobs<NotificationJobData>(getNotificationQueue())
    expect(
      notices
        .filter((job) => job.data.type === 'billing_paid_cancelled')
        .map((job) => job.data.userId)
        .toSorted()
    ).toEqual([owner.id, coOwner.id].toSorted())
  })

  it('tells owners of a cancel at the period end by notification carrying the email, once', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    const paid = paidFrom(row)
    const cancelling = { ...paid, cancelAtPeriodEnd: true, version: paid.version + 1 }

    await emitBillingDiff(paid, cancelling, 'owner')
    await emitBillingDiff(paid, cancelling, 'webhook')

    // The billing address has no account, so it gets the email directly; owners get it through the notification.
    const direct = await mailsOf(tenantId, 'paid_cancelled')
    expect(direct.map((mail) => mail.recipient)).toEqual(['accounts@example.test'])
    expect(direct[0]?.variables).toMatchObject({
      endsOn: '1 November 2026',
      beforeFirstCharge: 'false',
    })
    const notices = await queuedJobs<NotificationJobData>(getNotificationQueue())
    expect(notices.map((job) => job.data.userId).toSorted()).toEqual(
      [owner.id, coOwner.id].toSorted()
    )
    expect(notices[0]?.data).toMatchObject({
      type: 'billing_paid_cancelled',
      title: 'Paid ends on 1 November 2026',
      email: { templateKey: 'paid_cancelled' },
    })
    expect(notices[0]?.data.body).toContain('keeps Paid until 1 November 2026, then moves to Free.')

    for (const job of notices) await processNotificationJob(job)
    expect(await recipientsOf(tenantId, 'paid_cancelled')).toEqual(
      ['accounts@example.test', owner.email, coOwner.email].toSorted()
    )
    const inApp =
      await sql`select id from notifications where user_id = any(${[owner.id, coOwner.id]}) and type = 'billing_paid_cancelled'`
    expect(inApp).toHaveLength(2)
    await sql`delete from notifications where user_id = any(${[owner.id, coOwner.id]})`
  })

  it('tells owners of a cancel before the first charge in the same way, naming the workspace and the trial end', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    const deferred = { ...paidFrom(row), trialEndsAt: PERIOD_END }
    const backToTrial = {
      ...deferred,
      state: 'trialing' as const,
      priceId: null,
      currentPeriodEnd: null,
      version: deferred.version + 1,
    }

    await emitBillingDiff(deferred, backToTrial, 'staff', { isStaffCancel: true })

    const direct = await mailsOf(tenantId, 'paid_cancelled')
    expect(direct.map((mail) => mail.recipient)).toEqual(['accounts@example.test'])
    expect(direct[0]?.variables).toMatchObject({
      endsOn: '1 November 2026',
      beforeFirstCharge: 'true',
    })
    const notices = await queuedJobs<NotificationJobData>(getNotificationQueue())
    expect(notices.map((job) => job.data.userId).toSorted()).toEqual(
      [owner.id, coOwner.id].toSorted()
    )
    expect(notices[0]?.data).toMatchObject({
      type: 'billing_paid_cancelled',
      title: 'Your Paid plan is cancelled',
      email: { templateKey: 'paid_cancelled' },
    })
    expect(notices[0]?.data.body).toContain(
      "Paid for Billing Co was cancelled before its first charge, so no payment was taken. Billing Co's trial continues until 1 November 2026."
    )
    expect(notices[0]?.data.body).not.toContain('You cancelled')
    expect(notices[0]?.data.body).not.toContain('Your trial')
  })

  it('confirms a cancel before the first charge once when the owner write and its webhook both bring it in', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    const deferred = { ...paidFrom(row), trialEndsAt: PERIOD_END }
    const backToTrial = {
      ...deferred,
      state: 'trialing' as const,
      priceId: null,
      currentPeriodEnd: null,
      version: deferred.version + 1,
    }
    /**
     * The workspace's queued cancel notices.
     * @returns The jobs.
     */
    const notices = async (): Promise<Job<NotificationJobData>[]> => {
      const jobs = await queuedJobs<NotificationJobData>(getNotificationQueue())
      return jobs.filter(
        (job) =>
          job.data.type === 'billing_paid_cancelled' &&
          (job.data.metadata as { tenantId?: string } | undefined)?.tenantId === tenantId
      )
    }

    await emitBillingDiff(deferred, backToTrial, 'owner', { actorUserId: owner.id })
    await emitBillingDiff(deferred, { ...backToTrial, version: backToTrial.version + 1 }, 'webhook')

    expect(await recipientsOf(tenantId, 'paid_cancelled')).toEqual(['accounts@example.test'])
    const queued = await notices()
    expect(queued.map((job) => job.data.userId).toSorted()).toEqual(
      [owner.id, coOwner.id].toSorted()
    )
    for (const job of queued) await processNotificationJob(job)
    expect(await recipientsOf(tenantId, 'paid_cancelled')).toEqual(
      ['accounts@example.test', owner.email, coOwner.email].toSorted()
    )

    // The same change once more, after every mail went out: its notice jobs run and add nothing.
    await deliverAll(tenantId)
    await emitBillingDiff(deferred, backToTrial, 'webhook')
    for (const job of await notices()) await processNotificationJob(job)
    expect(await mailsOf(tenantId, 'paid_cancelled')).toHaveLength(3)
    const inApp =
      await sql`select id from notifications where user_id = any(${[owner.id, coOwner.id]}) and type = 'billing_paid_cancelled'`
    expect(inApp).toHaveLength(2)
    await sql`delete from notifications where user_id = any(${[owner.id, coOwner.id]})`
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

  it('tells a paused subscription apart from a halt, and warns once for each', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    const paid = paidFrom(row)
    const paused = { ...paid, pausedAt: PERIOD_END, version: paid.version + 1 }

    await emitBillingDiff(paid, paused, 'webhook')
    await emitBillingDiff(paid, paused, 'webhook')

    expect(await variablesOf(tenantId, 'payment_failed')).toMatchObject({ stoppedBy: 'paused' })
    const notices = await queuedJobs<NotificationJobData>(getNotificationQueue())
    expect(notices.map((job) => job.data.userId).toSorted()).toEqual(
      [owner.id, coOwner.id].toSorted()
    )
    expect(notices[0]?.data.title).toBe('Your Paid subscription is paused')
    expect(notices[0]?.data.body).toContain('Update your payment method by')
  })

  it('warns again for a second halt with its own time', async () => {
    const { tenantId, row } = await team()
    const paid = paidFrom(row)
    const firstHalt = { ...paid, state: 'past_due' as const, haltedAt: PERIOD_END }
    const secondAt = new Date(PERIOD_END.getTime() + 40 * 24 * 60 * 60 * 1000)
    const secondHalt = { ...firstHalt, haltedAt: secondAt, pastDueSince: secondAt }

    await emitBillingDiff(paid, firstHalt, 'webhook')
    await emitBillingDiff(paid, secondHalt, 'webhook')

    // The billing address gets each halt's email directly; owners get theirs through two notifications each.
    expect(await recipientsOf(tenantId, 'payment_failed')).toEqual([
      'accounts@example.test',
      'accounts@example.test',
    ])
    expect(await queuedJobs(getNotificationQueue())).toHaveLength(4)
  })

  it('never mails the billing address in place of a deactivated owner who holds it', async () => {
    const { tenantId, owner, coOwner, row } = await team()
    await sql`update users set active = false where id = ${coOwner.id}`
    const held = { ...row, billingEmail: coOwner.email.toUpperCase() }

    await emitBillingDiff(held, paidFrom(held), 'webhook')

    expect(await recipientsOf(tenantId, 'paid_welcome')).toEqual([owner.email])
  })

  it('tells no requester who is no longer a member', async () => {
    const { tenantId, viewer, row } = await team()
    const request = await openRequest(tenantId, viewer.id)
    await sql`delete from user_memberships where user_id = ${viewer.id} and tenant_id = ${tenantId}`

    await emitBillingDiff(row, paidFrom(row), 'webhook', { fulfilledRequests: [request] })

    expect(await mailsOf(tenantId, 'upgrade_request_fulfilled')).toHaveLength(0)
    expect(await mailsOf(tenantId, 'paid_welcome')).toHaveLength(3)
  })

  it('closes a member’s open upgrade requests when they leave, are removed or are deleted', async () => {
    const { tenantId, owner, coOwner, viewer } = await team()
    const editor = await createTrackedUser()
    await sql`insert into user_memberships (user_id, tenant_id, role) values (${editor.id}, ${tenantId}, 'editor')`
    for (const user of [viewer, editor, coOwner]) await openRequest(tenantId, user.id)

    await leaveTenant({ userId: viewer.id }, tenantId)
    await removeMember({ userId: owner.id }, tenantId, editor.id)
    const { user: staff } = await createTrackedStaff('admin')
    await deleteUser({ userId: staff.id }, coOwner.id, 'Closing the account')

    for (const user of [viewer, editor, coOwner]) {
      expect(await openRequestsOf(user.id)).toHaveLength(0)
    }
  })

  it('sends a suspended workspace no "subscribe again" mail for its cycle-end cancel', async () => {
    const { tenantId } = await team()
    await makePaying(tenantId)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`

    await runFrequentBilling(new Date())

    expect(await readBilling(tenantId)).toHaveProperty('cancelAtPeriodEnd', true)
    expect(await mailsOf(tenantId, 'paid_cancelled')).toHaveLength(0)
    expect(await mailsOf(tenantId, 'moved_to_free')).toHaveLength(0)
  })

  it('tells a suspended workspace it moved to Free, with no button', async () => {
    const { tenantId, row } = await team()
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`
    const cancelling = { ...paidFrom(row), cancelAtPeriodEnd: true }

    await emitBillingDiff(cancelling, { ...row, version: cancelling.version + 1 }, 'job')

    expect(await variablesOf(tenantId, 'moved_to_free')).toMatchObject({
      downgradeCause: 'lifecycle',
    })
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
