/**
 * @file The billing mail the schedulers send on their own, each step with a
 * fixed `now`: the trial's three-day, last-day and halfway reminders, the
 * yearly renewal reminder and the two win-back emails per Free period. Each
 * is claimed before it is sent, so two runs at once send it once; the last
 * day is judged in the workspace's time zone; a suspended or archived
 * workspace is never claimed and gets none of them. No worker runs: the test
 * reads the `email_messages` rows and the queued notification jobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import type { NotificationJobData } from '@/jobs/notification.job'
import {
  sendRenewalUpcoming,
  sendTrialEnding,
  sendTrialEndsToday,
  sendTrialMidpoint,
  sendWinback,
} from '@/services/billing/billing-emails.service'
import {
  runDailyBilling,
  runFrequentBilling,
  type BillingRunReport,
} from '@/services/billing/billing-scheduler.service'
import { sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeNotificationSubscriber } from '@/services/notification-emitter.service'
import {
  closeQueue,
  getBillingQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  forgetProviderPlans,
  loadPlans,
  plans,
  billingColumn,
  readBilling,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import { deleteTrackedUsers } from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'

vi.mock('@/services/billing/billing-provider.service', async () => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  return fakeProviderModule()
})

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/**
 * The runs' fixed time: 18:00 UTC on 1 November 2030, which is 23:30 that
 * day in Kolkata. Years ahead, so every history row this file writes is
 * later than the rows its workspaces were created with.
 */
const NOW = new Date('2030-11-01T18:00:00.000Z')

beforeAll(async () => {
  await loadPlans()
})

afterEach(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await getBillingQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await closeNotificationSubscriber()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * A workspace with its owner and a billing address no owner has.
 * @param timeZone - The workspace's time zone.
 * @returns The workspace's id and owner.
 */
async function team(timeZone = 'UTC'): Promise<{ tenantId: string; ownerId: string }> {
  const { tenant, owner } = await workspace()
  await sql`update tenant_settings set timezone = ${timeZone} where tenant_id = ${tenant.id}`
  await setBilling(tenant.id, { billingEmail: 'accounts@example.test' })
  return { tenantId: tenant.id, ownerId: owner.id }
}

/**
 * A workspace on a Paid trial.
 * @param startedAt - When the trial started.
 * @param endsAt - When it ends.
 * @param timeZone - The workspace's time zone.
 * @returns The workspace's id and owner.
 */
async function trial(
  startedAt: Date,
  endsAt: Date,
  timeZone = 'UTC'
): Promise<{ tenantId: string; ownerId: string }> {
  const made = await team(timeZone)
  await setBilling(made.tenantId, {
    state: 'trialing',
    planId: plans.paidId,
    trialStartedAt: startedAt,
    trialEndsAt: endsAt,
  })
  return made
}

/**
 * A workspace paying for Paid, with no subscription the provider would read.
 * @param interval - The price's interval.
 * @param periodEnd - When its paid period ends.
 * @returns The workspace's id and owner.
 */
async function paying(
  interval: 'month' | 'year',
  periodEnd: Date
): Promise<{ tenantId: string; ownerId: string }> {
  const made = await team()
  await setBilling(made.tenantId, {
    state: 'active',
    planId: plans.paidId,
    priceId: interval === 'year' ? plans.yearPriceId : plans.monthPriceId,
    currentPeriodEnd: periodEnd,
  })
  return made
}

/**
 * Record a state change in a workspace's history at a given time.
 * @param tenantId - The workspace.
 * @param from - The state before, or null for a new workspace.
 * @param to - The state after.
 * @param at - When.
 */
async function history(tenantId: string, from: string | null, to: string, at: Date): Promise<void> {
  await sql`insert into billing_state_history (tenant_id, from_state, to_state, cause, source, at) values (${tenantId}, ${from}, ${to}, 'test', 'job', ${at.toISOString()}::timestamptz)`
}

/**
 * A Free workspace that fell to Free from `from` at `freeSince`.
 * @param from - The state it fell from.
 * @param freeSince - When it moved to Free.
 * @returns The workspace's id and owner.
 */
async function fellToFree(
  from: string,
  freeSince: Date
): Promise<{ tenantId: string; ownerId: string }> {
  const made = await team()
  await setBilling(made.tenantId, { state: 'free', planId: plans.freeId })
  await history(made.tenantId, from, 'free', freeSince)
  return made
}

/**
 * Suspend or archive a workspace.
 * @param tenantId - The workspace.
 * @param state - Its lifecycle state.
 */
async function setLifecycle(tenantId: string, state: 'suspended' | 'archived'): Promise<void> {
  await sql`update tenants set lifecycle_state = ${state}, deleted_at = case when ${state} = 'archived' then now() end where id = ${tenantId}`
}

/**
 * One workspace's mail of one template.
 * @param tenantId - The workspace.
 * @param templateKey - The template.
 * @returns Each message's recipient and stored variables, by recipient.
 */
async function mailsOf(
  tenantId: string,
  templateKey: string
): Promise<{ recipient: string; variables: Record<string, string> }[]> {
  return [
    ...(await sql<{ recipient: string; variables: Record<string, string> }[]>`
      select recipient, variables from email_messages
      where tenant_id = ${tenantId} and template_key = ${templateKey}
      order by recipient, created_at`),
  ]
}

/**
 * Every message a workspace was sent.
 * @param tenantId - The workspace.
 * @returns The template keys, sorted.
 */
async function allMailOf(tenantId: string): Promise<string[]> {
  const rows = await sql<
    { templateKey: string }[]
  >`select template_key as "templateKey" from email_messages where tenant_id = ${tenantId}`
  return rows.map((row) => row.templateKey).toSorted()
}

/**
 * The queued notification jobs for one workspace.
 * @param tenantId - The workspace.
 * @returns The jobs' data.
 */
async function noticesOf(tenantId: string): Promise<NotificationJobData[]> {
  const jobs = await queuedJobs<NotificationJobData>(getNotificationQueue())
  return jobs
    .map((job) => job.data)
    .filter((data) => (data.metadata as { tenantId?: string } | undefined)?.tenantId === tenantId)
}

/**
 * How many rows one step acted on across overlapping runs.
 * @param reports - Each run's report.
 * @param step - The step's name.
 * @returns The sum of its `acted` counts.
 */
function actedIn(reports: readonly BillingRunReport[], step: string): number {
  return reports.reduce((sum, report) => sum + (report[step]?.acted ?? 0), 0)
}

describe('trial reminders', () => {
  it('reminds owners three days before the trial ends, once, by notification carrying the email', async () => {
    const { tenantId, ownerId } = await trial(
      new Date(NOW.getTime() - 12 * DAY),
      new Date(NOW.getTime() + 2 * DAY + HOUR)
    )

    await runFrequentBilling(NOW)
    await runFrequentBilling(new Date(NOW.getTime() + HOUR))

    const notices = await noticesOf(tenantId)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      userId: ownerId,
      type: 'billing_trial_ending',
      email: {
        templateKey: 'trial_ending',
        variables: {
          trialEndsOn: '3 November 2030',
          memberLimit: '3',
          membersUsed: '1',
          monthlyPrice: '999',
          yearlyPrice: '9,990',
        },
      },
    })
    // The billing address has no account, so it gets the email directly.
    const direct = await mailsOf(tenantId, 'trial_ending')
    expect(direct.map((mail) => mail.recipient)).toEqual(['accounts@example.test'])
    const row = await readBilling(tenantId)
    expect(row.trialReminder3dSentAt).not.toBeNull()
  })

  it('sends no three-day reminder while more than three days are left', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 10 * DAY),
      new Date(NOW.getTime() + 3 * DAY + HOUR)
    )

    await runFrequentBilling(NOW)

    expect(await noticesOf(tenantId)).toStrictEqual([])
    expect(await mailsOf(tenantId, 'trial_ending')).toStrictEqual([])
    expect(await billingColumn(tenantId, 'trialReminder3dSentAt')).toBeNull()
  })

  it('sends the last-day reminder on the day the trial ends, once', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 14 * DAY),
      new Date('2030-11-01T20:00:00.000Z')
    )

    await runFrequentBilling(NOW)
    await runFrequentBilling(new Date(NOW.getTime() + HOUR))

    const mails = await mailsOf(tenantId, 'trial_ends_today')
    expect(mails).toHaveLength(2)
    expect(mails[0]?.variables).toMatchObject({ memberLimit: '3', membersUsed: '1' })
  })

  it('judges the last day in the workspace time zone', async () => {
    // 20:00 UTC on 1 November is 01:30 on 2 November in Kolkata.
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 14 * DAY),
      new Date('2030-11-01T20:00:00.000Z'),
      'Asia/Kolkata'
    )

    // 23:30 on 1 November in Kolkata: the trial ends tomorrow there.
    await runFrequentBilling(NOW)
    expect(await mailsOf(tenantId, 'trial_ends_today')).toStrictEqual([])
    expect(await billingColumn(tenantId, 'trialReminderLastDaySentAt')).toBeNull()

    // 00:30 on 2 November in Kolkata: today.
    await runFrequentBilling(new Date('2030-11-01T19:00:00.000Z'))
    expect(await mailsOf(tenantId, 'trial_ends_today')).toHaveLength(2)
  })

  it('sends the halfway reminder once half the trial has passed', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 7 * DAY),
      new Date(NOW.getTime() + 7 * DAY)
    )

    await runFrequentBilling(NOW)
    await runFrequentBilling(new Date(NOW.getTime() + HOUR))

    const mails = await mailsOf(tenantId, 'trial_midpoint')
    expect(mails).toHaveLength(2)
    expect(mails[0]?.variables).toMatchObject({
      daysLeft: '7',
      trialEndsOn: '8 November 2030',
      usageSummary: '1 member',
    })
  })

  it('sends no halfway reminder before half the trial has passed', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 6 * DAY),
      new Date(NOW.getTime() + 8 * DAY)
    )

    await runFrequentBilling(NOW)

    expect(await allMailOf(tenantId)).toStrictEqual([])
    expect(await billingColumn(tenantId, 'trialMidpointSentAt')).toBeNull()
  })

  it('sends no halfway reminder for a trial shorter than six days', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 3 * DAY),
      new Date(NOW.getTime() + 2 * DAY)
    )

    await runFrequentBilling(NOW)

    expect(await mailsOf(tenantId, 'trial_midpoint')).toStrictEqual([])
    expect(await billingColumn(tenantId, 'trialMidpointSentAt')).toBeNull()
  })

  it('gives a trial of exactly six days the three-day reminder and no halfway one', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 3 * DAY),
      new Date(NOW.getTime() + 3 * DAY)
    )

    await runFrequentBilling(NOW)

    expect(await mailsOf(tenantId, 'trial_midpoint')).toStrictEqual([])
    expect(await billingColumn(tenantId, 'trialMidpointSentAt')).toBeNull()
    expect(await noticesOf(tenantId)).toHaveLength(1)
  })

  it('sends the halfway reminder to a trial an hour longer than six days at its halfway point', async () => {
    const { tenantId } = await trial(
      new Date(NOW.getTime() - 3 * DAY - HOUR / 2),
      new Date(NOW.getTime() + 3 * DAY + HOUR / 2)
    )

    await runFrequentBilling(NOW)

    expect(await mailsOf(tenantId, 'trial_midpoint')).toHaveLength(2)
  })

  it('sends no three-day reminder for a trial of three days or less', async () => {
    const threeDayTrial = await trial(
      new Date(NOW.getTime() - DAY),
      new Date(NOW.getTime() + 2 * DAY)
    )
    const longer = await trial(
      new Date(NOW.getTime() - DAY - HOUR),
      new Date(NOW.getTime() + 2 * DAY)
    )

    await runFrequentBilling(NOW)

    expect(await noticesOf(threeDayTrial.tenantId)).toStrictEqual([])
    expect(await mailsOf(threeDayTrial.tenantId, 'trial_ending')).toStrictEqual([])
    expect(await billingColumn(threeDayTrial.tenantId, 'trialReminder3dSentAt')).toBeNull()
    expect(await noticesOf(longer.tenantId)).toHaveLength(1)
  })

  it('sends nothing for a claimed reminder whose workspace changed before the send, and logs it', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const ended = await trial(new Date(NOW.getTime() - 7 * DAY), new Date(NOW.getTime() + 7 * DAY))
    const claimed = await readBilling(ended.tenantId)
    await setBilling(ended.tenantId, { state: 'free', planId: plans.freeId })
    const suspended = await fellToFree('trialing', new Date(NOW.getTime() - 8 * DAY))
    const free = await readBilling(suspended.tenantId)
    await setLifecycle(suspended.tenantId, 'suspended')

    await sendTrialEnding(claimed, NOW)
    await sendTrialEndsToday(claimed, NOW)
    await sendTrialMidpoint(claimed, NOW)
    await sendWinback({ ...free, winback7dSentAt: NOW }, '7d', NOW)

    expect(await allMailOf(ended.tenantId)).toStrictEqual([])
    expect(await noticesOf(ended.tenantId)).toStrictEqual([])
    expect(await allMailOf(suspended.tenantId)).toStrictEqual([])
    const skipped = warn.mock.calls.filter(
      ([message]) => message === 'A claimed billing reminder is no longer due'
    )
    expect(skipped.map(([, meta]) => meta)).toStrictEqual([
      { tenantId: ended.tenantId, templateKey: 'trial_ending' },
      { tenantId: ended.tenantId, templateKey: 'trial_ends_today' },
      { tenantId: ended.tenantId, templateKey: 'trial_midpoint' },
      { tenantId: suspended.tenantId, templateKey: 'winback' },
    ])
    warn.mockRestore()
  })

  it('sends each reminder once when two runs overlap', async () => {
    const threeDays = await trial(
      new Date(NOW.getTime() - 12 * DAY),
      new Date(NOW.getTime() + 2 * DAY + HOUR)
    )
    const lastDay = await trial(
      new Date(NOW.getTime() - 14 * DAY),
      new Date('2030-11-01T20:00:00.000Z')
    )
    const halfway = await trial(
      new Date(NOW.getTime() - 7 * DAY),
      new Date(NOW.getTime() + 7 * DAY)
    )

    const reports = await Promise.all([runFrequentBilling(NOW), runFrequentBilling(NOW)])

    // Each claim went to exactly one of the two runs; the last-day trial is within three days too.
    expect(actedIn(reports, 'trial_ending_reminders')).toBe(2)
    expect(actedIn(reports, 'trial_last_day_reminders')).toBe(1)
    expect(actedIn(reports, 'trial_midpoint_reminders')).toBe(1)
    expect(await noticesOf(threeDays.tenantId)).toHaveLength(1)
    expect(await mailsOf(threeDays.tenantId, 'trial_ending')).toHaveLength(1)
    expect(await mailsOf(lastDay.tenantId, 'trial_ends_today')).toHaveLength(2)
    expect(await mailsOf(halfway.tenantId, 'trial_midpoint')).toHaveLength(2)
  })
})

describe('the yearly renewal reminder', () => {
  it('reminds owners a week before a yearly plan renews, once per period end', async () => {
    const periodEnd = new Date(NOW.getTime() + 5 * DAY)
    const { tenantId } = await paying('year', periodEnd)

    await runDailyBilling(NOW)
    await runDailyBilling(new Date(NOW.getTime() + DAY))

    const mails = await mailsOf(tenantId, 'renewal_upcoming')
    expect(mails).toHaveLength(2)
    expect(mails[0]?.variables).toMatchObject({ renewsOn: '6 November 2030', amount: '9,990' })
    expect(await billingColumn(tenantId, 'renewalReminderForPeriodEnd')).toStrictEqual(periodEnd)

    // The next year: a new period end gets its own reminder.
    const nextEnd = new Date(periodEnd.getTime() + 365 * DAY)
    await setBilling(tenantId, { currentPeriodEnd: nextEnd })
    await runDailyBilling(new Date(NOW.getTime() + 365 * DAY))
    await runDailyBilling(new Date(NOW.getTime() + 366 * DAY))

    const again = await mailsOf(tenantId, 'renewal_upcoming')
    expect(again).toHaveLength(4)
    expect(
      again
        .map((mail) => mail.variables['renewsOn'])
        .toSorted((a, b) => String(a).localeCompare(String(b)))
    ).toStrictEqual(['6 November 2030', '6 November 2030', '6 November 2031', '6 November 2031'])
  })

  it('sends nothing for a claimed renewal that is cancelling, monthly or no longer active, and logs it', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const periodEnd = new Date(NOW.getTime() + 5 * DAY)
    const cancelling = await paying('year', periodEnd)
    const monthly = await paying('year', periodEnd)
    const lapsed = await paying('year', periodEnd)
    const suspended = await paying('year', periodEnd)
    const claimed = await Promise.all(
      [cancelling, monthly, lapsed, suspended].map(({ tenantId }) => readBilling(tenantId))
    )
    await setBilling(cancelling.tenantId, { cancelAtPeriodEnd: true })
    await setBilling(monthly.tenantId, { priceId: plans.monthPriceId })
    await setBilling(lapsed.tenantId, { state: 'free', planId: plans.freeId, priceId: null })
    await setLifecycle(suspended.tenantId, 'suspended')

    for (const row of claimed) await sendRenewalUpcoming(row)

    const ids = [cancelling, monthly, lapsed, suspended].map(({ tenantId }) => tenantId)
    for (const tenantId of ids) expect(await allMailOf(tenantId)).toStrictEqual([])
    const skipped = warn.mock.calls.filter(
      ([message]) => message === 'A claimed billing reminder is no longer due'
    )
    expect(skipped.map(([, meta]) => meta)).toStrictEqual(
      ids.map((tenantId) => ({ tenantId, templateKey: 'renewal_upcoming' }))
    )
    warn.mockRestore()
  })

  it('sends no renewal reminder for a monthly plan, a cancelling plan, or a renewal further out', async () => {
    const monthly = await paying('month', new Date(NOW.getTime() + 5 * DAY))
    const cancelling = await paying('year', new Date(NOW.getTime() + 5 * DAY))
    await setBilling(cancelling.tenantId, { cancelAtPeriodEnd: true })
    const later = await paying('year', new Date(NOW.getTime() + 8 * DAY))

    await runDailyBilling(NOW)

    for (const { tenantId } of [monthly, cancelling, later]) {
      expect(await mailsOf(tenantId, 'renewal_upcoming')).toStrictEqual([])
      expect(await billingColumn(tenantId, 'renewalReminderForPeriodEnd')).toBeNull()
    }
  })

  it('reminds once when two daily runs overlap', async () => {
    const { tenantId } = await paying('year', new Date(NOW.getTime() + 5 * DAY))

    const reports = await Promise.all([runDailyBilling(NOW), runDailyBilling(NOW)])

    expect(actedIn(reports, 'renewal_reminders')).toBe(1)
    expect(await mailsOf(tenantId, 'renewal_upcoming')).toHaveLength(2)
  })
})

describe('win-back emails', () => {
  it('sends one on day 7 and one on day 30 after a trial fell to Free, each once', async () => {
    const freeSince = new Date(NOW.getTime() - 8 * DAY)
    const { tenantId } = await fellToFree('trialing', freeSince)

    await runDailyBilling(NOW)
    await runDailyBilling(new Date(NOW.getTime() + DAY))
    const first = await mailsOf(tenantId, 'winback')
    expect(first).toHaveLength(2)
    expect(first[0]?.variables).toMatchObject({ memberLimit: '3', monthlyPrice: '999' })

    await runDailyBilling(new Date(freeSince.getTime() + 30 * DAY + HOUR))
    await runDailyBilling(new Date(freeSince.getTime() + 31 * DAY + HOUR))
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(4)

    await runDailyBilling(new Date(freeSince.getTime() + 60 * DAY))
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(4)
  })

  it('sends none before day 7, and none to a workspace that was always Free', async () => {
    const early = await fellToFree('active', new Date(NOW.getTime() - 6 * DAY))
    const alwaysFree = await team()
    await history(alwaysFree.tenantId, null, 'free', new Date(NOW.getTime() - 40 * DAY))

    await runDailyBilling(NOW)

    expect(await mailsOf(early.tenantId, 'winback')).toStrictEqual([])
    expect(await mailsOf(alwaysFree.tenantId, 'winback')).toStrictEqual([])
  })

  it('sends none after the workspace upgrades again', async () => {
    const freeSince = new Date(NOW.getTime() - 8 * DAY)
    const { tenantId } = await fellToFree('past_due', freeSince)
    await history(tenantId, 'free', 'active', new Date(NOW.getTime() - 2 * DAY))
    await setBilling(tenantId, {
      state: 'active',
      planId: plans.paidId,
      priceId: plans.monthPriceId,
      currentPeriodEnd: new Date(NOW.getTime() + 28 * DAY),
    })

    await runDailyBilling(NOW)
    await runDailyBilling(new Date(freeSince.getTime() + 30 * DAY + HOUR))

    expect(await mailsOf(tenantId, 'winback')).toStrictEqual([])
  })

  it('gives a second Free period its own two emails', async () => {
    const firstFree = new Date(NOW.getTime() - 40 * DAY)
    const { tenantId } = await fellToFree('active', firstFree)
    await runDailyBilling(new Date(firstFree.getTime() + 7 * DAY + HOUR))
    await runDailyBilling(new Date(firstFree.getTime() + 30 * DAY + HOUR))
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(4)

    // Paid again for a while, then Free again.
    await history(tenantId, 'free', 'active', new Date(firstFree.getTime() + 31 * DAY))
    const secondFree = new Date(firstFree.getTime() + 35 * DAY)
    await history(tenantId, 'active', 'free', secondFree)

    await runDailyBilling(new Date(secondFree.getTime() + 7 * DAY + HOUR))
    await runDailyBilling(new Date(secondFree.getTime() + 8 * DAY + HOUR))
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(6)
    await runDailyBilling(new Date(secondFree.getTime() + 30 * DAY + HOUR))
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(8)
  })

  it('sends each once when two daily runs overlap', async () => {
    const { tenantId } = await fellToFree('trialing', new Date(NOW.getTime() - 8 * DAY))

    const reports = await Promise.all([runDailyBilling(NOW), runDailyBilling(NOW)])

    expect(actedIn(reports, 'winback_7d')).toBe(1)
    expect(await mailsOf(tenantId, 'winback')).toHaveLength(2)
  })
})

describe('a suspended or archived workspace', () => {
  it('gets none of the scheduled mail, and none of it is claimed', async () => {
    const workspaces = [
      await trial(new Date(NOW.getTime() - 12 * DAY), new Date(NOW.getTime() + 2 * DAY + HOUR)),
      await trial(new Date(NOW.getTime() - 14 * DAY), new Date('2030-11-01T20:00:00.000Z')),
      await trial(new Date(NOW.getTime() - 7 * DAY), new Date(NOW.getTime() + 7 * DAY)),
      await paying('year', new Date(NOW.getTime() + 5 * DAY)),
      await fellToFree('trialing', new Date(NOW.getTime() - 8 * DAY)),
      await fellToFree('active', new Date(NOW.getTime() - 31 * DAY)),
    ]
    for (const [index, { tenantId }] of workspaces.entries()) {
      await setLifecycle(tenantId, index % 2 === 0 ? 'suspended' : 'archived')
    }
    await runFrequentBilling(NOW)
    await runDailyBilling(NOW)

    for (const { tenantId } of workspaces) {
      expect(await allMailOf(tenantId)).toStrictEqual([])
      expect(await noticesOf(tenantId)).toStrictEqual([])
      const row = await readBilling(tenantId)
      expect([
        row.trialReminder3dSentAt,
        row.trialReminderLastDaySentAt,
        row.trialMidpointSentAt,
        row.renewalReminderForPeriodEnd,
        row.winback7dSentAt,
        row.winback30dSentAt,
      ]).toStrictEqual([null, null, null, null, null, null])
    }
  })
})
