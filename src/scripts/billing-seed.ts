/**
 * @file `pnpm billing:seed`: on local only, with `BILLING_FAKE_PROVIDER=true`,
 * create 13 workspaces (slugs `billing-*`) that cover every billing state, so
 * the billing screens can be walked without a payment. One owner,
 * `billing-owner@example.test`, owns them all; members are
 * `billing-member-<n>@example.test`. Paid workspaces get subscriptions on the
 * fake provider whose status matches the row, so a later sync keeps each
 * workspace where the seed put it.
 *
 * It writes through repositories and never through the services that mail,
 * notify or queue analytics, so a run sends nothing. A rerun puts every
 * workspace back: it keeps the workspace ids, resets each billing row in
 * full, replaces the members, history, grants, upgrade requests, alerts and
 * banner dismissals, and ends every fake subscription it replaces, so the
 * daily reconcile never finds an old one still running.
 * Prints slugs, ids and states only.
 */
import { fileURLToPath } from 'node:url'
import { and, eq, isNull, notInArray } from 'drizzle-orm'
import { getEnv, isBillingLocalToolAllowed, type Env } from '@/configs/env.config'
import type { BillingInterval, BillingState } from '@/constants/billing.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import {
  billingAlertModel,
  billingStateHistoryModel,
  tenantEntitlementGrantModel,
  upgradeRequestModel,
  userBannerDismissalModel,
  type NewTenantBilling,
  type PlanPrice,
} from '@/database/models/billing.model'
import { tenantInvitationModel } from '@/database/models/tenant-invitation.model'
import { userMembershipModel } from '@/database/models/user-membership.model'
import { BillingRepository } from '@/repositories/billing.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { createLinkedAccount, markEmailVerified } from '@/services/account-claim.service'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { closeDatabase, db, withTransaction } from '@/services/database.service'
import { closeRedis } from '@/services/redis.service'
import type { ProviderSubscription } from '@/types/billing'
import { BILLING_ALERT_TEXT } from '@/utilities/billing-alert-text.utilities'
import { effectiveBillingState } from '@/utilities/billing-rules.utilities'

const billingRepository = new BillingRepository()
const planRepository = new PlanRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * The address of the person who owns every seeded workspace.
 */
const SEED_OWNER_EMAIL = 'billing-owner@example.test'

/**
 * The role each seeded member holds: enough to ask for an upgrade, not to pay.
 */
const SEED_MEMBER_ROLE: MembershipRole = 'editor'

/**
 * The most members any seeded workspace has besides its owner.
 */
const SEED_MEMBER_COUNT = 4

/**
 * Statuses after which a fake subscription can no longer charge.
 */
const ENDED_STATUSES = new Set(['cancelled', 'completed', 'expired'])

/**
 * The environment slice the seed reads.
 */
type SeedEnv = Pick<Env, 'APP_ENV' | 'BILLING_FAKE_PROVIDER'>

/**
 * What every seeded workspace is built from.
 */
interface SeedContext {
  now: Date
  fake: FakeBillingProvider
  ownerId: string
  memberIds: string[]
  freePlanId: string
  paidPlanId: string
  monthPrice: PlanPrice
  yearPrice: PlanPrice
  graceDays: number
}

/**
 * One history row, dated relative to now.
 */
interface SeedHistory {
  from: BillingState | null
  to: BillingState
  cause: string
  daysAgo: number
}

/**
 * What a seeded workspace holds beyond its members.
 */
interface SeedResult {
  /**
   * The billing columns that differ from a fresh Free row.
   */
  billing: Partial<NewTenantBilling>
  history: SeedHistory[]
  /**
   * A staff grant of members, expiring in days.
   */
  grant?: { members: number; expiresInDays: number }
  /**
   * The member, by index, who asked for an upgrade.
   */
  upgradeRequestBy?: number
  /**
   * A duplicate-refunded alert's message.
   */
  alert?: string
}

/**
 * One seeded workspace: its slug, name, member count and billing.
 */
interface SeedTenant {
  slug: string
  name: string
  /**
   * Members besides the owner.
   */
  members: number
  /**
   * The effective state the workspace is in once seeded.
   */
  state: BillingState
  build: (context: SeedContext, tenantId: string) => SeedResult | Promise<SeedResult>
}

/**
 * A date some days from now; negative for the past.
 * @param context - The seed's clock.
 * @param days - Days from now.
 * @returns The date.
 */
function daysFromNow(context: SeedContext, days: number): Date {
  return new Date(context.now.getTime() + days * DAY_MS)
}

/**
 * Create a subscription on the fake for a workspace and a price.
 * @param context - The seed's fake and prices.
 * @param tenantId - The workspace its notes name.
 * @param interval - Which Paid price it bills.
 * @param startAt - A deferred first charge, or null.
 * @returns The subscription id.
 */
async function createFakeSubscription(
  context: SeedContext,
  tenantId: string,
  interval: BillingInterval,
  startAt: Date | null = null
): Promise<string> {
  const price = interval === 'year' ? context.yearPrice : context.monthPrice
  // A fresh fake plan each run: the fake's plans live in Redis, which may have been cleared.
  const providerPlanId = await context.fake.ensurePlan({ ...price, providerPlanId: null }, 'Paid')
  const created = await context.fake.createSubscription({
    providerPlanId,
    totalCount: interval === 'year' ? 5 : 60,
    expireBy: new Date(context.now.getTime() + HOUR_MS),
    startAt,
    notes: { tenantId, priceId: price.id },
  })
  return created.id
}

/**
 * A paid subscription on the fake, its first cycle paid, optionally started
 * some days ago.
 * @param context - The seed's fake and prices.
 * @param tenantId - The workspace.
 * @param interval - Which Paid price it bills.
 * @param startedDaysAgo - How long ago its cycle started.
 * @returns The subscription as the fake reads it.
 */
async function paidFakeSubscription(
  context: SeedContext,
  tenantId: string,
  interval: BillingInterval,
  startedDaysAgo = 0
): Promise<ProviderSubscription> {
  const id = await createFakeSubscription(context, tenantId, interval)
  await context.fake.fakeAdvance(id, 'active')
  if (startedDaysAgo > 0) await context.fake.fakeShiftBack(id, startedDaysAgo * DAY_MS)
  return context.fake.fetchSubscription(id)
}

/**
 * The billing columns of a workspace that pays through a fake subscription.
 * @param context - The seed's owner and plans.
 * @param sub - The subscription.
 * @param interval - Which Paid price it bills.
 * @returns The columns.
 */
function payingColumns(
  context: SeedContext,
  sub: ProviderSubscription,
  interval: BillingInterval
): Partial<NewTenantBilling> {
  return {
    state: 'active',
    planId: context.paidPlanId,
    priceId: interval === 'year' ? context.yearPrice.id : context.monthPrice.id,
    provider: 'fake',
    providerMode: 'test',
    providerSubscriptionId: sub.id,
    currentPeriodEnd: sub.currentEnd,
    payerUserId: context.ownerId,
    billingEmail: SEED_OWNER_EMAIL,
    checkoutStartedBy: context.ownerId,
  }
}

/**
 * A trial's history: created on it, and optionally upgraded from it.
 * @param startedDaysAgo - When the trial started.
 * @returns The rows.
 */
function trialHistory(startedDaysAgo: number): SeedHistory[] {
  return [{ from: null, to: 'trialing', cause: 'created', daysAgo: startedDaysAgo }]
}

/**
 * A workspace's history from a trial to a paid subscription.
 * @param paidDaysAgo - When the subscription started.
 * @returns The rows.
 */
function paidHistory(paidDaysAgo: number): SeedHistory[] {
  return [
    ...trialHistory(paidDaysAgo + 10),
    { from: 'trialing', to: 'active', cause: 'subscription_activated', daysAgo: paidDaysAgo },
  ]
}

/**
 * The 13 seeded workspaces, one per billing state the screens show.
 */
export const SEED_TENANTS: readonly SeedTenant[] = [
  {
    slug: 'billing-trial-10-days',
    name: 'Trial with 10 days left',
    members: 1,
    state: 'trialing',
    build: (context) => ({
      billing: {
        state: 'trialing',
        planId: context.paidPlanId,
        trialStartedAt: daysFromNow(context, -4),
        trialEndsAt: daysFromNow(context, 10),
      },
      history: trialHistory(4),
    }),
  },
  {
    slug: 'billing-trial-1-day',
    name: 'Trial with 1 day left',
    members: 1,
    state: 'trialing',
    build: (context) => ({
      billing: {
        state: 'trialing',
        planId: context.paidPlanId,
        trialStartedAt: daysFromNow(context, -13),
        trialEndsAt: daysFromNow(context, 1),
        // The reminders a trial this far along has already had.
        trialMidpointSentAt: daysFromNow(context, -6),
        trialReminder3dSentAt: daysFromNow(context, -2),
      },
      history: trialHistory(13),
    }),
  },
  {
    slug: 'billing-trial-ended',
    name: 'Trial ended',
    members: 1,
    state: 'free',
    build: (context) => ({
      billing: {
        state: 'free',
        planId: context.freePlanId,
        trialStartedAt: daysFromNow(context, -16),
        trialEndsAt: daysFromNow(context, -2),
        trialMidpointSentAt: daysFromNow(context, -9),
        trialReminder3dSentAt: daysFromNow(context, -5),
        trialReminderLastDaySentAt: daysFromNow(context, -2),
      },
      history: [
        ...trialHistory(16),
        { from: 'trialing', to: 'free', cause: 'trial_ended', daysAgo: 2 },
      ],
    }),
  },
  {
    slug: 'billing-free-under-limit',
    name: 'Free under its limit',
    members: 1,
    state: 'free',
    build: (context) => ({
      billing: { state: 'free', planId: context.freePlanId },
      history: [{ from: null, to: 'free', cause: 'created', daysAgo: 30 }],
    }),
  },
  {
    slug: 'billing-free-over-limit',
    name: 'Free over its limit',
    members: SEED_MEMBER_COUNT,
    state: 'free',
    // Paid once, cancelled, and kept the members it had: a downgrade never removes anyone.
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'month', 40)
      await context.fake.fakeAdvance(sub.id, 'cancelled')
      return {
        billing: {
          ...payingColumns(context, sub, 'month'),
          state: 'free',
          planId: context.freePlanId,
          cancelAtPeriodEnd: true,
        },
        history: [
          ...paidHistory(40),
          { from: 'active', to: 'free', cause: 'cancelled', daysAgo: 5 },
        ],
      }
    },
  },
  {
    slug: 'billing-active-monthly',
    name: 'Paid monthly',
    members: 2,
    state: 'active',
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'month')
      // A second checkout that the sync cancelled and refunded, for the staff alert.
      const duplicate = await paidFakeSubscription(context, tenantId, 'month')
      await context.fake.fakeAdvance(duplicate.id, 'cancelled')
      const refund = await context.fake.refundLatestPayment(duplicate.id)
      return {
        billing: payingColumns(context, sub, 'month'),
        history: paidHistory(0),
        alert:
          refund.status === 'refunded'
            ? BILLING_ALERT_TEXT.duplicateRefunded(
                duplicate.id,
                refund.amountMinor,
                refund.refundId
              )
            : BILLING_ALERT_TEXT.duplicateNothingPaid(duplicate.id),
      }
    },
  },
  {
    slug: 'billing-yearly-cancelling',
    name: 'Paid yearly, cancelling',
    members: 1,
    state: 'active',
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'year', 100)
      await context.fake.cancelSubscription(sub.id, true)
      return {
        billing: { ...payingColumns(context, sub, 'year'), cancelAtPeriodEnd: true },
        history: paidHistory(100),
      }
    },
  },
  {
    slug: 'billing-past-due-pending',
    name: 'Renewal failed, retrying',
    members: 1,
    state: 'past_due',
    // The renewal at the period end failed a day ago; the provider is still retrying.
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'month', 32)
      await context.fake.fakeAdvance(sub.id, 'pending')
      return {
        billing: {
          ...payingColumns(context, sub, 'month'),
          state: 'past_due',
          pastDueSince: daysFromNow(context, -1),
        },
        history: [
          ...paidHistory(32),
          { from: 'active', to: 'past_due', cause: 'payment_failed', daysAgo: 1 },
        ],
      }
    },
  },
  {
    slug: 'billing-past-due-halted',
    name: 'Renewal halted, 2 days of grace left',
    members: 1,
    state: 'past_due',
    build: async (context, tenantId) => {
      const haltedDaysAgo = Math.max(context.graceDays - 2, 0)
      const sub = await paidFakeSubscription(context, tenantId, 'month', 34 + haltedDaysAgo)
      await context.fake.fakeAdvance(sub.id, 'halted')
      return {
        billing: {
          ...payingColumns(context, sub, 'month'),
          state: 'past_due',
          pastDueSince: daysFromNow(context, -(haltedDaysAgo + 3)),
          haltedAt: daysFromNow(context, -haltedDaysAgo),
        },
        history: [
          ...paidHistory(34 + haltedDaysAgo),
          { from: 'active', to: 'past_due', cause: 'payment_failed', daysAgo: haltedDaysAgo + 3 },
        ],
      }
    },
  },
  {
    slug: 'billing-customer-cancelled',
    name: 'Cancelled from the bank',
    members: 1,
    state: 'active',
    // The payer cancelled the mandate in their UPI app or bank: Paid until the period ends.
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'month', 10)
      await context.fake.fakeAdvance(sub.id, 'cancelled')
      return {
        billing: { ...payingColumns(context, sub, 'month'), cancelAtPeriodEnd: true },
        history: paidHistory(10),
      }
    },
  },
  {
    slug: 'billing-interval-switch',
    name: 'Switching to yearly',
    members: 1,
    state: 'active',
    // The yearly subscription is authenticated and starts when the monthly one ends.
    build: async (context, tenantId) => {
      const sub = await paidFakeSubscription(context, tenantId, 'month', 12)
      await context.fake.cancelSubscription(sub.id, true)
      const nextId = await createFakeSubscription(context, tenantId, 'year', sub.currentEnd)
      await context.fake.fakeAdvance(nextId, 'authenticated')
      return {
        billing: {
          ...payingColumns(context, sub, 'month'),
          cancelAtPeriodEnd: true,
          nextSubscriptionId: nextId,
          nextPriceId: context.yearPrice.id,
          nextAuthenticatedAt: new Date(context.now.getTime() - HOUR_MS),
        },
        history: paidHistory(12),
      }
    },
  },
  {
    slug: 'billing-free-grant',
    name: 'Free with a grant ending soon',
    members: 3,
    state: 'free',
    build: (context) => ({
      billing: { state: 'free', planId: context.freePlanId },
      history: [{ from: null, to: 'free', cause: 'created', daysAgo: 20 }],
      grant: { members: 10, expiresInDays: 3 },
    }),
  },
  {
    slug: 'billing-upgrade-request',
    name: 'Free with an upgrade request',
    members: 2,
    state: 'free',
    build: (context) => ({
      billing: { state: 'free', planId: context.freePlanId },
      history: [{ from: null, to: 'free', cause: 'created', daysAgo: 20 }],
      upgradeRequestBy: 0,
    }),
  },
]

/**
 * Every billing column a seeded row resets, so a rerun never keeps a value
 * from an earlier state.
 */
const RESET_COLUMNS = {
  priceId: null,
  trialStartedAt: null,
  trialEndsAt: null,
  trialOnOwnerAccept: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  haltedAt: null,
  pausedAt: null,
  provider: null,
  providerMode: null,
  providerSubscriptionId: null,
  pendingSubscriptionId: null,
  nextSubscriptionId: null,
  nextPriceId: null,
  nextAuthenticatedAt: null,
  payerUserId: null,
  billingEmail: null,
  checkoutStartedBy: null,
  cardChangeStartedAt: null,
  cardChangeStartedBy: null,
  trialMidpointSentAt: null,
  trialReminder3dSentAt: null,
  trialReminderLastDaySentAt: null,
  trialEndedNotifiedAt: null,
  renewalReminderForPeriodEnd: null,
  winback7dSentAt: null,
  winback30dSentAt: null,
  lifecycleCancelSentAt: null,
  cancelMarkerSubscriptionId: null,
  cancelMarkerBy: null,
  cancelMarkerUserId: null,
  cancelMarkerAt: null,
  disputeOpen: false,
  syncedAt: null,
} as const satisfies Partial<NewTenantBilling>

/**
 * The seed's person with an address. A missing one is created as a sign-in
 * link would create it, verified and able to sign in by link; an unverified
 * one is verified. Either way it gets the seed's name.
 * @param email - The address.
 * @param firstName - The first name.
 * @param lastName - The last name.
 * @returns The user id.
 */
async function ensureUser(email: string, firstName: string, lastName: string): Promise<string> {
  const existing = await userRepository.findByEmail(email)
  let id = existing?.id
  if (id === undefined) {
    const created = await withTransaction(async (tx) => createLinkedAccount(email, tx))
    id = created.id
  } else if (existing?.emailVerifiedAt === null) {
    await markEmailVerified(id)
  }
  await userRepository.update(id, { firstName, lastName })
  return id
}

/**
 * End every running fake subscription whose notes name one of the
 * workspaces, so a rerun leaves none for the reconcile to adopt.
 * @param fake - The fake provider.
 * @param tenantIds - The seeded workspaces that already exist.
 */
async function endOldSubscriptions(
  fake: FakeBillingProvider,
  tenantIds: ReadonlySet<string>
): Promise<void> {
  if (tenantIds.size === 0) return
  for (const sub of await fake.listRecentSubscriptions(new Date(0))) {
    if (!tenantIds.has(sub.notes.tenantId ?? '') || ENDED_STATUSES.has(sub.status)) continue
    await fake.fakeAdvance(sub.id, 'cancelled')
  }
}

/**
 * Make a workspace's members exactly the owner and the first `count`
 * seeded members, and drop its open invitations, which would hold seats.
 * @param tenantId - The workspace.
 * @param context - The seed's people.
 * @param count - Members besides the owner.
 */
async function resetMembers(tenantId: string, context: SeedContext, count: number): Promise<void> {
  const wanted = new Map<string, MembershipRole>([[context.ownerId, 'owner']])
  for (const id of context.memberIds.slice(0, count)) wanted.set(id, SEED_MEMBER_ROLE)
  await withTransaction(async (tx) => {
    const others = and(
      eq(userMembershipModel.tenantId, tenantId),
      notInArray(userMembershipModel.userId, [...wanted.keys()])
    )
    await tx.delete(userMembershipModel).where(others)
    for (const [userId, role] of wanted) {
      await tx
        .insert(userMembershipModel)
        .values({ tenantId, userId, role })
        .onConflictDoUpdate({
          target: [userMembershipModel.userId, userMembershipModel.tenantId],
          set: { role },
        })
    }
    await tx
      .delete(tenantInvitationModel)
      .where(
        and(eq(tenantInvitationModel.tenantId, tenantId), isNull(tenantInvitationModel.acceptedAt))
      )
  })
}

/**
 * Write a workspace's billing row and the rows around it, replacing what an
 * earlier run left.
 * @param tenantId - The workspace.
 * @param context - The seed's clock and people.
 * @param result - What the workspace holds.
 */
async function writeBilling(
  tenantId: string,
  context: SeedContext,
  result: SeedResult
): Promise<void> {
  const { now } = context
  await withTransaction(async (tx) => {
    const locked = await billingRepository.lockByTenantId(tenantId, tx)
    const row: Omit<NewTenantBilling, 'tenantId'> = {
      ...RESET_COLUMNS,
      state: 'free',
      planId: context.freePlanId,
      ...result.billing,
    }
    if (locked === undefined) {
      await billingRepository.insertForTenant({ ...row, tenantId }, tx)
    } else {
      await billingRepository.updateVersioned(tenantId, locked.version, row, tx)
    }
    await tx.delete(billingStateHistoryModel).where(eq(billingStateHistoryModel.tenantId, tenantId))
    for (const entry of result.history) {
      await billingRepository.appendHistory(
        {
          tenantId,
          fromState: entry.from,
          toState: entry.to,
          cause: entry.cause,
          source: 'job',
          at: new Date(now.getTime() - entry.daysAgo * DAY_MS),
        },
        tx
      )
    }
    await tx
      .delete(tenantEntitlementGrantModel)
      .where(eq(tenantEntitlementGrantModel.tenantId, tenantId))
    if (result.grant !== undefined) {
      await planRepository.insertGrant(
        {
          tenantId,
          key: 'members',
          value: result.grant.members,
          reason: 'Seeded by pnpm billing:seed',
          expiresAt: new Date(now.getTime() + result.grant.expiresInDays * DAY_MS),
        },
        tx
      )
    }
    await tx.delete(upgradeRequestModel).where(eq(upgradeRequestModel.tenantId, tenantId))
    const requester =
      result.upgradeRequestBy === undefined ? undefined : context.memberIds[result.upgradeRequestBy]
    if (requester !== undefined) {
      await billingRepository.openUpgradeRequest(
        {
          tenantId,
          requestedBy: requester,
          entitlementKey: 'members',
          surface: 'limit',
          expiresAt: new Date(now.getTime() + 30 * DAY_MS),
        },
        tx
      )
    }
    await tx.delete(billingAlertModel).where(eq(billingAlertModel.tenantId, tenantId))
    if (result.alert !== undefined) {
      await billingRepository.insertAlert(
        { tenantId, kind: 'duplicate_refunded', message: result.alert },
        tx
      )
    }
    await tx.delete(userBannerDismissalModel).where(eq(userBannerDismissalModel.tenantId, tenantId))
  })
}

/**
 * Refuse an existing workspace with a seed slug that the seed's owner does
 * not own alone: it is someone's own workspace, not an earlier seed's.
 * @param slug - The slug.
 * @param tenantId - The workspace.
 * @param ownerId - The seed's owner.
 * @throws {Error} When any other person owns it, or the seed's owner does not.
 */
async function assertSeedOwned(slug: string, tenantId: string, ownerId: string): Promise<void> {
  const owners = await db
    .select({ userId: userMembershipModel.userId })
    .from(userMembershipModel)
    .where(and(eq(userMembershipModel.tenantId, tenantId), eq(userMembershipModel.role, 'owner')))
  if (owners.length !== 1 || owners[0]?.userId !== ownerId) {
    throw new Error(
      `Workspace ${slug} is not owned by the seed's owner, so the seed changed nothing. Archive or rename it, then run the seed again.`
    )
  }
}

/**
 * Put an earlier seed's workspace back to its name and to active, in case
 * someone renamed or suspended it since.
 * @param spec - The workspace's slug and name.
 * @param tenantId - The workspace.
 */
async function resetTenant(spec: SeedTenant, tenantId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tenantRepository.transitionLifecycle(tenantId, ['suspended'], 'active', tx)
    await tenantRepository.update(tenantId, { name: spec.name }, {}, tx)
  })
}

/**
 * Create a seeded workspace, its owner the seed's owner.
 * @param spec - The workspace's slug and name.
 * @param ownerId - The seed's owner.
 * @returns The new workspace's id.
 */
async function createTenant(spec: SeedTenant, ownerId: string): Promise<string> {
  const tenant = await tenantRepository.create({ name: spec.name, slug: spec.slug, ownerId })
  return tenant.id
}

/**
 * Why the seed must not run here, or null when it may.
 * @param env - The environment slice.
 * @returns The one-line refusal, or null.
 */
function refusalFor(env: SeedEnv): string | null {
  if (!isBillingLocalToolAllowed(env)) {
    return 'The billing seed runs on APP_ENV=local only. Run it on your own machine.'
  }
  if (!env.BILLING_FAKE_PROVIDER) {
    return 'The billing seed needs the fake payment provider. Set BILLING_FAKE_PROVIDER=true in .env and run it again.'
  }
  return null
}

/**
 * The seed's people, plans, prices and fake provider.
 * @param fake - The fake provider.
 * @returns The context every workspace is built from.
 * @throws {Error} When the billing migration's plans or prices are missing.
 */
async function loadContext(fake: FakeBillingProvider): Promise<SeedContext> {
  const free = await planRepository.findPlanByKey('free')
  const paid = await planRepository.findPlanByKey('paid')
  const monthPrice = paid && (await planRepository.activePrice(paid.id, 'INR', 'month'))
  const yearPrice = paid && (await planRepository.activePrice(paid.id, 'INR', 'year'))
  if (!free || !paid || !monthPrice || !yearPrice) {
    throw new Error(
      'The Free and Paid plans or their prices are missing. Run pnpm db:migrate first.'
    )
  }
  const settings = await planRepository.getSettings()
  const ownerId = await ensureUser(SEED_OWNER_EMAIL, 'Billing', 'Owner')
  const memberIds: string[] = []
  for (let n = 1; n <= SEED_MEMBER_COUNT; n += 1) {
    memberIds.push(
      await ensureUser(`billing-member-${String(n)}@example.test`, 'Member', String(n))
    )
  }
  return {
    now: new Date(),
    fake,
    ownerId,
    memberIds,
    freePlanId: free.id,
    paidPlanId: paid.id,
    monthPrice,
    yearPrice,
    graceDays: settings.pastDueGraceDays,
  }
}

/**
 * Seed the 13 workspaces, printing each one's slug, id and state.
 * @param _argv - The arguments after the script path; the seed takes none.
 * @param env - The environment slice; defaults to the validated environment.
 * @returns The process exit code: 0 on success, 1 on a refusal or any failure.
 */
export async function runBillingSeed(
  _argv: readonly string[],
  env: SeedEnv = getEnv()
): Promise<number> {
  try {
    const refusal = refusalFor(env)
    if (refusal !== null) throw new Error(refusal)
    const fake = getBillingProvider()
    if (!(fake instanceof FakeBillingProvider)) {
      throw new Error(
        'The billing seed needs the fake payment provider. Set BILLING_FAKE_PROVIDER=true in .env and run it again.'
      )
    }
    const context = await loadContext(fake)
    const existing = new Map<string, string>()
    for (const spec of SEED_TENANTS) {
      const tenant = await tenantRepository.findBySlug(spec.slug)
      if (tenant !== undefined) existing.set(spec.slug, tenant.id)
    }
    for (const [slug, tenantId] of existing) {
      await assertSeedOwned(slug, tenantId, context.ownerId)
    }
    await endOldSubscriptions(fake, new Set(existing.values()))
    for (const spec of SEED_TENANTS) {
      const found = existing.get(spec.slug)
      const tenantId = found ?? (await createTenant(spec, context.ownerId))
      if (found !== undefined) await resetTenant(spec, found)
      await resetMembers(tenantId, context, spec.members)
      await writeBilling(tenantId, context, await spec.build(context, tenantId))
      const row = await billingRepository.findByTenantId(tenantId)
      const state = row && effectiveBillingState(row, new Date(), context.graceDays)
      if (state !== spec.state) {
        throw new Error(
          `${spec.slug} ended up ${state ?? 'with no billing row'}, not ${spec.state}. Check its seed recipe.`
        )
      }
      process.stdout.write(`${spec.slug} ${tenantId} ${state}\n`)
    }
    process.stdout.write(`Seeded ${String(SEED_TENANTS.length)} billing workspaces.\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBillingSeed(process.argv.slice(2))
  await closeRedis()
  await closeDatabase()
}
