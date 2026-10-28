/**
 * @file The pure mapping from a workspace's billing row and its provider
 * subscriptions to the row's next values, one case per mapping rule plus the
 * provider facts that refine them: a period end only counts once paid, a
 * deferred start keeps the trial end, a cancelled checkout only clears its
 * id, and a scheduled cancel is our own record.
 */
import { describe, expect, it } from 'vite-plus/test'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import type { ProviderSubscription, ProviderSubscriptionStatus } from '@/types/billing'
import {
  nextBillingRow,
  type BillingSubscriptions,
} from '@/utilities/billing-state-machine.utilities'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-03-01T00:00:00Z')
const GRACE_DAYS = 7
const TENANT_ID = 'tenant-1'
const PRICE_MONTH = 'price-month'
const PRICE_YEAR = 'price-year'

/**
 * A time some days after the fixed start.
 * @param days - Days after the start; negative for before.
 * @returns The date.
 */
const at = (days: number): Date => new Date(T0.getTime() + days * DAY)

/**
 * A billing row with every column, overridden where a case needs it.
 * @param overrides - The columns to change.
 * @returns The row.
 */
function row(overrides: Partial<TenantBillingRecord> = {}): TenantBillingRecord {
  return {
    tenantId: TENANT_ID,
    state: 'free',
    planId: 'plan-free',
    priceId: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialOnOwnerAccept: false,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    haltedAt: null,
    pausedAt: null,
    provider: 'fake',
    providerMode: 'test',
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
    version: 1,
    updatedAt: at(-30),
    ...overrides,
  }
}

/**
 * A provider subscription for this workspace, overridden where a case needs it.
 * @param id - The subscription id.
 * @param status - Its status.
 * @param overrides - Other fields to change.
 * @returns The subscription.
 */
function sub(
  id: string,
  status: ProviderSubscriptionStatus,
  overrides: Partial<ProviderSubscription> = {}
): ProviderSubscription {
  const isActive = status === 'active'
  return {
    id,
    status,
    planId: 'plan_FAKE1',
    currentStart: isActive ? at(0) : null,
    currentEnd: isActive ? at(30) : null,
    startAt: at(0),
    createdAt: at(-1),
    endedAt: null,
    chargeAt: isActive ? at(30) : null,
    notes: { tenantId: TENANT_ID, priceId: PRICE_MONTH },
    paidCount: isActive ? 1 : 0,
    customerId: status === 'created' ? null : 'cust_FAKE1',
    expireBy: null,
    hasScheduledChanges: false,
    latestInvoicePaid: isActive,
    ...overrides,
  }
}

/**
 * Run the mapping at day 1 with the default grace.
 * @param current - The row.
 * @param subs - The fetched subscriptions.
 * @param now - The time; day 1 by default.
 * @returns The mapping's answer.
 */
const map = (current: TenantBillingRecord, subs: BillingSubscriptions, now = at(1)) =>
  nextBillingRow(current, subs, now, GRACE_DAYS)

/**
 * A paying workspace on `sub_cur`, period ending on day 30.
 */
const paying = (overrides: Partial<TenantBillingRecord> = {}): TenantBillingRecord =>
  row({
    state: 'active',
    planId: 'plan-paid',
    priceId: PRICE_MONTH,
    providerSubscriptionId: 'sub_cur',
    currentPeriodEnd: at(30),
    ...overrides,
  })

describe('nextBillingRow: the pending checkout', () => {
  it('makes an authenticated deferred start current and active, and keeps the trial end', () => {
    const trialing = row({
      state: 'trialing',
      planId: 'plan-paid',
      trialStartedAt: at(-4),
      trialEndsAt: at(10),
      pendingSubscriptionId: 'sub_new',
    })
    const result = map(trialing, {
      pending: sub('sub_new', 'authenticated', { startAt: at(10) }),
    })
    expect(result.patch).toStrictEqual({
      state: 'active',
      providerSubscriptionId: 'sub_new',
      pendingSubscriptionId: null,
      priceId: PRICE_MONTH,
      currentPeriodEnd: at(10),
    })
    expect(result.patch).not.toHaveProperty('trialEndsAt')
    expect(result.cause).toBe('subscription_activated')
    expect(result.actions).toStrictEqual([])
  })

  it('makes a paid active checkout current with its paid period end', () => {
    const result = map(row({ pendingSubscriptionId: 'sub_new' }), {
      pending: sub('sub_new', 'active', { notes: { tenantId: TENANT_ID, priceId: PRICE_YEAR } }),
    })
    expect(result.patch).toStrictEqual({
      state: 'active',
      providerSubscriptionId: 'sub_new',
      pendingSubscriptionId: null,
      priceId: PRICE_YEAR,
      currentPeriodEnd: at(30),
    })
    expect(result.cause).toBe('subscription_activated')
  })

  it('stamps the period end now for an active checkout whose cycle is not paid yet, so buffer and grace bound it', () => {
    const result = map(row({ pendingSubscriptionId: 'sub_new' }), {
      pending: sub('sub_new', 'active', { latestInvoicePaid: false }),
    })
    expect(result.patch).toMatchObject({ state: 'active', currentPeriodEnd: at(1) })
    expect(result.actions).toStrictEqual([])
  })

  it('stamps the period end now when a found subscription with an unpaid cycle replaces a lapsed one', () => {
    const result = map(
      paying({ cancelAtPeriodEnd: true }),
      {
        current: sub('sub_cur', 'cancelled'),
        swept: [sub('sub_new', 'active', { latestInvoicePaid: false })],
      },
      at(40)
    )
    expect(result.patch).toMatchObject({
      providerSubscriptionId: 'sub_new',
      currentPeriodEnd: at(40),
    })
  })

  it('resets a scheduled cancel when a new checkout becomes current', () => {
    const cancelled = paying({ cancelAtPeriodEnd: true, pendingSubscriptionId: 'sub_new' })
    const result = map(
      cancelled,
      {
        current: sub('sub_cur', 'cancelled'),
        pending: sub('sub_new', 'active', { currentEnd: at(70) }),
      },
      at(40)
    )
    expect(result.patch).toStrictEqual({
      providerSubscriptionId: 'sub_new',
      pendingSubscriptionId: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: at(70),
    })
    expect(result.patch).not.toHaveProperty('state')
  })

  it('changes nothing while the checkout is still created', () => {
    const result = map(row({ pendingSubscriptionId: 'sub_new' }), {
      pending: sub('sub_new', 'created'),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it.each(['expired', 'cancelled', 'completed'] as const)(
    'only clears the pending id when the checkout is %s',
    (status) => {
      const result = map(row({ state: 'trialing', pendingSubscriptionId: 'sub_new' }), {
        pending: sub('sub_new', status),
      })
      expect(result).toStrictEqual({
        patch: { pendingSubscriptionId: null },
        cause: null,
        actions: [],
      })
    }
  )

  it.each(['pending', 'halted', 'paused'] as const)(
    'leaves a never-authenticated checkout that reads %s alone',
    (status) => {
      const result = map(row({ pendingSubscriptionId: 'sub_new' }), {
        pending: sub('sub_new', status, { customerId: null, paidCount: 0 }),
      })
      expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
    }
  )

  it('refunds a second paid subscription while the current one is live', () => {
    const result = map(paying({ pendingSubscriptionId: 'sub_dup' }), {
      current: sub('sub_cur', 'active'),
      pending: sub('sub_dup', 'active'),
    })
    expect(result.patch).toStrictEqual({ pendingSubscriptionId: null })
    expect(result.cause).toBeNull()
    expect(result.actions).toStrictEqual([{ kind: 'refund_duplicate', subscriptionId: 'sub_dup' }])
  })
})

describe('nextBillingRow: subscriptions found by the sweep', () => {
  it('adopts a paid subscription when the workspace has no live one', () => {
    const result = map(row(), { swept: [sub('sub_found', 'active')] })
    expect(result.patch).toMatchObject({
      state: 'active',
      providerSubscriptionId: 'sub_found',
      priceId: PRICE_MONTH,
      currentPeriodEnd: at(30),
    })
    expect(result.cause).toBe('subscription_activated')
  })

  it('refunds a paid subscription found while the current one is live', () => {
    const result = map(paying(), {
      current: sub('sub_cur', 'active'),
      swept: [sub('sub_found', 'active')],
    })
    expect(result.patch).toStrictEqual({})
    expect(result.actions).toStrictEqual([
      { kind: 'refund_duplicate', subscriptionId: 'sub_found' },
    ])
  })

  it('keeps the first of two found subscriptions and refunds the second', () => {
    const result = map(row(), {
      swept: [sub('sub_first', 'active'), sub('sub_second', 'active')],
    })
    expect(result.patch.providerSubscriptionId).toBe('sub_first')
    expect(result.actions).toStrictEqual([
      { kind: 'refund_duplicate', subscriptionId: 'sub_second' },
    ])
  })

  it('ignores a found subscription that never started or has ended', () => {
    const result = map(row(), {
      swept: [sub('sub_a', 'created'), sub('sub_b', 'cancelled'), sub('sub_c', 'expired')],
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })
})

/**
 * A paying workspace with a yearly switch scheduled on `sub_next`.
 * @param overrides - The columns to change.
 * @returns The row.
 */
const switching = (overrides: Partial<TenantBillingRecord> = {}): TenantBillingRecord =>
  paying({ nextSubscriptionId: 'sub_next', nextPriceId: PRICE_YEAR, ...overrides })

describe('nextBillingRow: the interval switch', () => {
  it('cancels the current subscription at cycle end once the next one is authenticated', () => {
    const result = map(switching(), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'authenticated', { startAt: at(30) }),
    })
    expect(result.patch).toStrictEqual({ nextAuthenticatedAt: at(1) })
    expect(result.cause).toBeNull()
    expect(result.actions).toStrictEqual([
      { kind: 'cancel_current_at_cycle_end', subscriptionId: 'sub_cur' },
    ])
  })

  it('does not cancel again once the current one is cancelling', () => {
    const result = map(switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(0) }), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'authenticated', { startAt: at(30) }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('stamps the first authenticated read of the next subscription, and keeps it after', () => {
    const first = map(switching({ cancelAtPeriodEnd: true }), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'authenticated', { startAt: at(30) }),
    })
    expect(first.patch).toStrictEqual({ nextAuthenticatedAt: at(1) })

    const later = map(
      switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(1) }),
      { current: sub('sub_cur', 'active'), next: sub('sub_next', 'active') },
      at(5)
    )
    expect(later.patch).not.toHaveProperty('nextAuthenticatedAt')
  })

  it('does not stamp a next subscription with a failed charge', () => {
    const result = map(switching(), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'halted', { customerId: 'cust_FAKE1' }),
    })
    expect(result.patch).not.toHaveProperty('nextAuthenticatedAt')
  })

  it('waits while the next subscription is still created', () => {
    const result = map(switching(), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'created'),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it.each(['expired', 'cancelled'] as const)(
    'clears the next ids when the next subscription is %s before the handover',
    (status) => {
      const result = map(switching(), {
        current: sub('sub_cur', 'active'),
        next: sub('sub_next', status),
      })
      expect(result).toStrictEqual({
        patch: { nextSubscriptionId: null, nextPriceId: null },
        cause: null,
        actions: [],
      })
    }
  )

  it('clears the stamp when an authenticated next subscription ends before the handover', () => {
    const result = map(switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(0) }), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'cancelled'),
    })
    expect(result.patch).toStrictEqual({
      nextSubscriptionId: null,
      nextPriceId: null,
      nextAuthenticatedAt: null,
    })
  })

  it('clears the stamp on the handover', () => {
    const result = map(
      switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(0) }),
      {
        current: sub('sub_cur', 'cancelled'),
        next: sub('sub_next', 'authenticated', { startAt: at(30) }),
      },
      at(30)
    )
    expect(result.patch).toMatchObject({
      providerSubscriptionId: 'sub_next',
      nextSubscriptionId: null,
      nextAuthenticatedAt: null,
    })
  })

  it('hands over when the current subscription has ended', () => {
    const result = map(
      switching({ cancelAtPeriodEnd: true }),
      {
        current: sub('sub_cur', 'cancelled'),
        next: sub('sub_next', 'authenticated', { startAt: at(30) }),
      },
      at(30)
    )
    expect(result.patch).toStrictEqual({
      providerSubscriptionId: 'sub_next',
      priceId: PRICE_YEAR,
      nextSubscriptionId: null,
      nextPriceId: null,
      cancelAtPeriodEnd: false,
    })
    expect(result.cause).toBe('interval_switch')
    expect(result.actions).toStrictEqual([{ kind: 'promote_next' }])
  })

  it('hands over once a cancelling period has ended, even before the cancel shows', () => {
    const result = map(
      switching({ cancelAtPeriodEnd: true }),
      {
        current: sub('sub_cur', 'active'),
        next: sub('sub_next', 'active', { currentEnd: at(395) }),
      },
      at(31)
    )
    expect(result.patch).toMatchObject({
      providerSubscriptionId: 'sub_next',
      currentPeriodEnd: at(395),
      cancelAtPeriodEnd: false,
    })
    expect(result.actions).toStrictEqual([{ kind: 'promote_next' }])
  })

  it('does not hand over while the current subscription runs and is not cancelling', () => {
    const result = map(
      switching(),
      {
        current: sub('sub_cur', 'active'),
        next: sub('sub_next', 'authenticated', { startAt: at(30) }),
      },
      at(31)
    )
    expect(result.patch).not.toHaveProperty('providerSubscriptionId')
  })
})

describe('nextBillingRow: a switch paid after the current subscription renewed', () => {
  /**
   * The current subscription after it charged the cycle from day 30.
   */
  const renewed = sub('sub_cur', 'active', {
    currentStart: at(30),
    currentEnd: at(60),
    paidCount: 2,
  })

  it('refunds the next subscription, keeps the current one, and alerts staff naming both', () => {
    const result = map(
      switching(),
      { current: renewed, next: sub('sub_next', 'authenticated', { startAt: at(30) }) },
      at(31)
    )
    expect(result.patch).toStrictEqual({
      currentPeriodEnd: at(60),
      nextSubscriptionId: null,
      nextPriceId: null,
    })
    expect(result.cause).toBeNull()
    expect(result.actions).toStrictEqual([
      { kind: 'refund_duplicate', subscriptionId: 'sub_next', cause: 'late_switch' },
      {
        kind: 'alert',
        alert: 'reconcile_repair',
        message:
          'Interval switch sub_next was paid after subscription sub_cur renewed, so we kept sub_cur and are refunding sub_next. Its own alert reports the refund.',
        subscriptionId: 'sub_next',
      },
    ])
  })

  it('refunds it when the current paid cycle ends after the stored period end, and clears its stamp', () => {
    const current = sub('sub_cur', 'active', { currentStart: null, currentEnd: at(60) })
    const result = map(
      switching({ nextAuthenticatedAt: at(0) }),
      { current, next: sub('sub_next', 'active', { startAt: at(30), currentEnd: at(395) }) },
      at(31)
    )
    expect(result.patch).toMatchObject({
      nextSubscriptionId: null,
      nextPriceId: null,
      nextAuthenticatedAt: null,
    })
    expect(result.patch).not.toHaveProperty('providerSubscriptionId')
    expect(result.actions).toContainEqual({
      kind: 'refund_duplicate',
      subscriptionId: 'sub_next',
      cause: 'late_switch',
    })
    expect(result.actions).not.toContainEqual({
      kind: 'cancel_current_at_cycle_end',
      subscriptionId: 'sub_cur',
    })
  })

  it('does not read a started but unpaid cycle of the current one as a renewal: no refund', () => {
    const unpaid = sub('sub_cur', 'active', {
      currentStart: at(30),
      currentEnd: at(60),
      latestInvoicePaid: false,
    })
    const result = map(
      switching(),
      { current: unpaid, next: sub('sub_next', 'authenticated', { startAt: at(30) }) },
      at(30)
    )
    expect(result.actions).not.toContainEqual({
      kind: 'refund_duplicate',
      subscriptionId: 'sub_next',
    })
    expect(result.actions).toContainEqual({
      kind: 'cancel_current_at_cycle_end',
      subscriptionId: 'sub_cur',
    })
    expect(result.patch).not.toHaveProperty('nextSubscriptionId')

    const handover = map(
      switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(29) }),
      { current: unpaid, next: sub('sub_next', 'authenticated', { startAt: at(30) }) },
      at(30)
    )
    expect(handover.patch).toMatchObject({ providerSubscriptionId: 'sub_next' })
    expect(handover.actions).toStrictEqual([{ kind: 'promote_next' }])
  })

  it('still hands over normally when the next one was authenticated before the renewal', () => {
    const before = map(switching(), {
      current: sub('sub_cur', 'active'),
      next: sub('sub_next', 'authenticated', { startAt: at(30) }),
    })
    expect(before.actions).toStrictEqual([
      { kind: 'cancel_current_at_cycle_end', subscriptionId: 'sub_cur' },
    ])

    const handover = map(
      switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(1) }),
      {
        current: sub('sub_cur', 'cancelled'),
        next: sub('sub_next', 'active', {
          startAt: at(30),
          currentStart: at(30),
          currentEnd: at(395),
        }),
      },
      at(30)
    )
    expect(handover.patch).toMatchObject({ providerSubscriptionId: 'sub_next' })
    expect(handover.actions).toStrictEqual([{ kind: 'promote_next' }])
  })

  it('never refunds a resubscribe: the current one is cancelling and cannot renew', () => {
    const result = map(
      switching({ cancelAtPeriodEnd: true, nextAuthenticatedAt: at(0) }),
      { current: renewed, next: sub('sub_next', 'authenticated', { startAt: at(30) }) },
      at(29)
    )
    expect(result.actions).not.toContainEqual({
      kind: 'refund_duplicate',
      subscriptionId: 'sub_next',
    })
  })
})

describe('nextBillingRow: a next subscription with a failed charge', () => {
  it.each(['pending', 'halted', 'paused'] as const)(
    'neither cancels the current subscription nor hands over to a next one that reads %s',
    (status) => {
      const next = sub('sub_next', status, { customerId: 'cust_FAKE1', paidCount: 0 })
      const running = map(switching(), { current: sub('sub_cur', 'active'), next })
      expect(running).toStrictEqual({ patch: {}, cause: null, actions: [] })

      const ended = map(
        switching({ cancelAtPeriodEnd: true }),
        { current: sub('sub_cur', 'cancelled', { paidCount: 1 }), next },
        at(31)
      )
      expect(ended.patch).not.toHaveProperty('providerSubscriptionId')
      expect(ended.actions).not.toContainEqual({ kind: 'promote_next' })
    }
  )
})

describe('nextBillingRow: the current subscription', () => {
  it('moves the period end to a paid cycle without a history cause', () => {
    const result = map(paying({ currentPeriodEnd: at(0) }), {
      current: sub('sub_cur', 'active', { currentEnd: at(30) }),
    })
    expect(result).toStrictEqual({
      patch: { currentPeriodEnd: at(30) },
      cause: null,
      actions: [],
    })
  })

  it('keeps the stored period end while the cycle is unpaid', () => {
    const result = map(paying({ currentPeriodEnd: at(0) }), {
      current: sub('sub_cur', 'active', { currentEnd: at(60), latestInvoicePaid: false }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('recovers a past-due workspace when the subscription is active again', () => {
    const pastDue = paying({
      state: 'past_due',
      pastDueSince: at(-2),
      haltedAt: at(-1),
      pausedAt: at(-1),
    })
    const result = map(pastDue, { current: sub('sub_cur', 'active') })
    expect(result.patch).toStrictEqual({
      state: 'active',
      pastDueSince: null,
      haltedAt: null,
      pausedAt: null,
    })
    expect(result.cause).toBe('subscription_recovered')
  })

  it('never clears a scheduled cancel the provider cannot show', () => {
    const result = map(paying({ cancelAtPeriodEnd: true }), {
      current: sub('sub_cur', 'active'),
    })
    expect(result.patch).not.toHaveProperty('cancelAtPeriodEnd')
  })

  it('keeps an authenticated deferred start active', () => {
    const result = map(paying({ currentPeriodEnd: at(10) }), {
      current: sub('sub_cur', 'authenticated', { startAt: at(10) }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('marks a failed renewal past due from now', () => {
    const result = map(paying(), { current: sub('sub_cur', 'pending', { paidCount: 1 }) })
    expect(result.patch).toStrictEqual({ state: 'past_due', pastDueSince: at(1) })
    expect(result.cause).toBe('payment_failed')
  })

  it('keeps the first failure time on a later pending read', () => {
    const result = map(paying({ state: 'past_due', pastDueSince: at(-3) }), {
      current: sub('sub_cur', 'pending', { paidCount: 1 }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('treats a failed first charge of an authenticated deferred start as past due', () => {
    const result = map(paying(), {
      current: sub('sub_cur', 'pending', { paidCount: 0, customerId: 'cust_FAKE1' }),
    })
    expect(result.patch.state).toBe('past_due')
  })

  it('leaves a never-authenticated current subscription that reads pending alone', () => {
    const result = map(paying(), {
      current: sub('sub_cur', 'pending', { paidCount: 0, customerId: null }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('marks a halted subscription past due and starts the grace clock', () => {
    const result = map(paying(), { current: sub('sub_cur', 'halted', { paidCount: 1 }) })
    expect(result.patch).toStrictEqual({
      state: 'past_due',
      pastDueSince: at(1),
      haltedAt: at(1),
    })
    expect(result.cause).toBe('subscription_halted')
    expect(result.actions).toStrictEqual([])
  })

  it('cancels a halted subscription once grace ends, and stays past due until it is cancelled', () => {
    const halted = paying({ state: 'past_due', pastDueSince: at(-9), haltedAt: at(-7) })
    const result = map(halted, { current: sub('sub_cur', 'halted', { paidCount: 1 }) }, at(0))
    expect(result.patch).toStrictEqual({})
    expect(result.actions).toStrictEqual([{ kind: 'cancel_now', subscriptionId: 'sub_cur' }])
  })

  it('does not cancel a halted subscription a moment before grace ends', () => {
    const halted = paying({ state: 'past_due', pastDueSince: at(-9), haltedAt: at(-7) })
    const result = map(
      halted,
      { current: sub('sub_cur', 'halted', { paidCount: 1 }) },
      new Date(at(0).getTime() - 1)
    )
    expect(result.actions).toStrictEqual([])
  })

  it('marks a paused subscription past due and starts the grace clock', () => {
    const result = map(paying(), { current: sub('sub_cur', 'paused', { paidCount: 1 }) })
    expect(result.patch).toStrictEqual({
      state: 'past_due',
      pastDueSince: at(1),
      pausedAt: at(1),
    })
    expect(result.cause).toBe('subscription_paused')
  })

  it('cancels a paused subscription once grace ends', () => {
    const paused = paying({ state: 'past_due', pastDueSince: at(-8), pausedAt: at(-8) })
    const result = map(paused, { current: sub('sub_cur', 'paused', { paidCount: 1 }) })
    expect(result.actions).toStrictEqual([{ kind: 'cancel_now', subscriptionId: 'sub_cur' }])
  })

  it('keeps a customer-cancelled subscription active and cancelling until its period ends', () => {
    const result = map(paying(), { current: sub('sub_cur', 'cancelled', { paidCount: 1 }) })
    expect(result).toStrictEqual({
      patch: { cancelAtPeriodEnd: true },
      cause: null,
      actions: [],
    })
  })

  it('keeps a cancelled subscription inside the buffer after its period end', () => {
    const result = map(
      paying({ cancelAtPeriodEnd: true }),
      { current: sub('sub_cur', 'cancelled', { paidCount: 1 }) },
      at(33)
    )
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('moves a cancelled subscription to Free after its period end and buffer', () => {
    const result = map(
      paying({ cancelAtPeriodEnd: true }),
      { current: sub('sub_cur', 'cancelled', { paidCount: 1 }) },
      at(34)
    )
    expect(result.patch).toStrictEqual({ state: 'free' })
    expect(result.cause).toBe('cancelled')
  })

  it('moves a cancelled subscription with no paid period to Free', () => {
    const result = map(paying({ currentPeriodEnd: null }), {
      current: sub('sub_cur', 'cancelled', { paidCount: 1 }),
    })
    expect(result.patch).toStrictEqual({ state: 'free', cancelAtPeriodEnd: true })
  })

  it('moves a past-due workspace to Free when its subscription is cancelled after grace', () => {
    const halted = paying({
      state: 'past_due',
      currentPeriodEnd: at(-12),
      pastDueSince: at(-12),
      haltedAt: at(-8),
    })
    const result = map(halted, { current: sub('sub_cur', 'cancelled', { paidCount: 1 }) })
    expect(result.patch).toStrictEqual({
      state: 'free',
      pastDueSince: null,
      haltedAt: null,
    })
    expect(result.cause).toBe('grace_ended')
  })

  it('moves a past-due workspace to Free when its subscription is cancelled inside grace', () => {
    const halted = paying({ state: 'past_due', pastDueSince: at(-2), haltedAt: at(-1) })
    const result = map(halted, { current: sub('sub_cur', 'cancelled', { paidCount: 1 }) })
    expect(result.patch.state).toBe('free')
    expect(result.cause).toBe('cancelled')
  })

  it('returns a deferred start cancelled before its first charge to the trial', () => {
    const upgraded = paying({
      trialStartedAt: at(-4),
      trialEndsAt: at(10),
      currentPeriodEnd: at(10),
    })
    const result = map(upgraded, { current: sub('sub_cur', 'cancelled', { paidCount: 0 }) })
    expect(result.patch).toStrictEqual({
      state: 'trialing',
      priceId: null,
      currentPeriodEnd: null,
    })
    expect(result.cause).toBe('cancelled')
  })

  it('moves a completed subscription to Free and alerts staff', () => {
    const result = map(paying(), { current: sub('sub_cur', 'completed', { paidCount: 60 }) })
    expect(result.patch).toStrictEqual({ state: 'free' })
    expect(result.cause).toBe('subscription_completed')
    expect(result.actions).toStrictEqual([
      {
        kind: 'alert',
        alert: 'subscription_completed',
        message:
          'Subscription sub_cur billed its last cycle, so the workspace moved to Free. No action needed.',
      },
    ])
  })

  it('does not alert again for a completed subscription already on Free', () => {
    const result = map(paying({ state: 'free' }), {
      current: sub('sub_cur', 'completed', { paidCount: 60 }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it('moves an expired subscription to Free', () => {
    const result = map(paying(), { current: sub('sub_cur', 'expired') })
    expect(result.patch).toStrictEqual({ state: 'free' })
    expect(result.cause).toBe('subscription_expired')
  })

  it('changes nothing for a current subscription that never started', () => {
    const result = map(paying(), { current: sub('sub_cur', 'created') })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it.each(['halted', 'paused'] as const)(
    'cancels a %s subscription of a workspace already on Free, without a new grace window',
    (status) => {
      const lapsed = paying({ state: 'free', planId: 'plan-free' })
      const result = map(lapsed, { current: sub('sub_cur', status, { paidCount: 1 }) })
      expect(result).toStrictEqual({
        patch: {},
        cause: null,
        actions: [{ kind: 'cancel_now', subscriptionId: 'sub_cur' }],
      })
    }
  )

  it.each(['halted', 'paused'] as const)(
    'adopts a new checkout on a Free workspace whose %s subscription is being cancelled',
    (status) => {
      const lapsed = paying({
        state: 'free',
        planId: 'plan-free',
        pendingSubscriptionId: 'sub_new',
      })
      const result = map(lapsed, {
        current: sub('sub_cur', status, { paidCount: 1 }),
        pending: sub('sub_new', 'active', { currentEnd: at(31) }),
      })
      expect(result.patch).toMatchObject({
        state: 'active',
        providerSubscriptionId: 'sub_new',
        pendingSubscriptionId: null,
        currentPeriodEnd: at(31),
      })
      expect(result.cause).toBe('subscription_activated')
      expect(result.actions).toStrictEqual([{ kind: 'cancel_now', subscriptionId: 'sub_cur' }])
    }
  )

  it('adopts a running subscription the sweep found on a Free workspace whose subscription is being cancelled', () => {
    const lapsed = paying({ state: 'free', planId: 'plan-free' })
    const result = map(lapsed, {
      current: sub('sub_cur', 'pending', { paidCount: 1 }),
      swept: [sub('sub_found', 'active', { currentEnd: at(31) })],
    })
    expect(result.patch).toMatchObject({
      state: 'active',
      providerSubscriptionId: 'sub_found',
      currentPeriodEnd: at(31),
    })
    expect(result.actions).toStrictEqual([{ kind: 'cancel_now', subscriptionId: 'sub_cur' }])
  })

  it('cancels an authenticated pending subscription of a workspace already on Free', () => {
    const result = map(paying({ state: 'free' }), {
      current: sub('sub_cur', 'pending', { paidCount: 1 }),
    })
    expect(result).toStrictEqual({
      patch: {},
      cause: null,
      actions: [{ kind: 'cancel_now', subscriptionId: 'sub_cur' }],
    })
  })

  it('cancels the lapsed live subscription of a trialing workspace rather than mark it past due', () => {
    const extended = paying({ state: 'trialing', trialEndsAt: at(10), currentPeriodEnd: null })
    const result = map(extended, {
      current: sub('sub_cur', 'halted', { paidCount: 1 }),
    })
    expect(result.patch).toStrictEqual({})
    expect(result.cause).toBeNull()
    expect(result.actions).toStrictEqual([{ kind: 'cancel_now', subscriptionId: 'sub_cur' }])
  })

  it('leaves a never-authenticated pending subscription of a workspace on Free alone', () => {
    const result = map(paying({ state: 'free' }), {
      current: sub('sub_cur', 'pending', { paidCount: 0, customerId: null }),
    })
    expect(result).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })

  it.each(['trialing', 'free'] as const)(
    'raises no alert on the first invoice.paid sync, which moves a %s row to active before the period end is known',
    (state) => {
      const checkingOut = row({
        state,
        planId: 'plan-paid',
        trialStartedAt: state === 'trialing' ? at(-4) : null,
        trialEndsAt: state === 'trialing' ? at(10) : null,
        pendingSubscriptionId: 'sub_new',
      })
      // Razorpay sends invoice.paid before subscription.activated: the subscription reads authenticated, with no start or paid cycle yet.
      const result = map(checkingOut, {
        pending: sub('sub_new', 'authenticated', { startAt: null }),
      })
      expect(result.patch).toMatchObject({
        state: 'active',
        providerSubscriptionId: 'sub_new',
      })
      expect(result.patch).not.toHaveProperty('currentPeriodEnd')
      expect(result.actions).toStrictEqual([])
    }
  )

  it('raises no alert on a re-sync of an active row that has a paid period end', () => {
    const result = map(paying(), { current: sub('sub_cur', 'authenticated', { startAt: null }) })
    expect(result.patch).toStrictEqual({})
    expect(result.actions).toStrictEqual([])
  })

  it('alerts on the daily reconcile or a staff Resync of a row already active with no paid period end', () => {
    const result = map(paying({ currentPeriodEnd: null }), {
      current: sub('sub_cur', 'active', { latestInvoicePaid: false }),
    })
    expect(result.actions).toStrictEqual([
      {
        kind: 'alert',
        alert: 'reconcile_repair',
        message:
          'The workspace is active on subscription sub_cur with no paid period end. Check its invoices in Razorpay.',
        subscriptionId: 'sub_cur',
      },
    ])
  })

  it('changes nothing when no subscription was fetched', () => {
    expect(map(paying(), {})).toStrictEqual({ patch: {}, cause: null, actions: [] })
  })
})
