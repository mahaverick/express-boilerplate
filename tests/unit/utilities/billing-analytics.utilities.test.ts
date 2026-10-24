/**
 * @file Which billing analytics events a committed change sends, read from
 * the row before and after it: each event once, attributed to the checkout's
 * starter, the payer or the trial's owner; nothing for a write that changes
 * nothing an event reports; the cancel's `by`, the payment failure's code and
 * the downgrade's cause.
 */
import { describe, expect, it } from 'vite-plus/test'
import type { BillingInterval } from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import {
  billingDiffEvents,
  type BillingAnalyticsContext,
} from '@/utilities/billing-analytics.utilities'

const NOW = new Date('2026-11-01T00:00:00.000Z')
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z')
const NEXT_PERIOD_END = new Date('2027-01-01T00:00:00.000Z')

/**
 * A billing row, overridden where a case needs it.
 * @param overrides - The columns to change.
 * @returns The row.
 */
function row(overrides: Partial<TenantBillingRecord> = {}): TenantBillingRecord {
  return {
    tenantId: 'tenant-1',
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
    disputeOpen: false,
    syncedAt: null,
    version: 1,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * A row paying monthly on subscription `sub_1`.
 * @param overrides - The columns to change.
 * @returns The row.
 */
function paying(overrides: Partial<TenantBillingRecord> = {}): TenantBillingRecord {
  return row({
    state: 'active',
    planId: 'plan-paid',
    priceId: 'price-month',
    currentPeriodEnd: PERIOD_END,
    providerSubscriptionId: 'sub_1',
    payerUserId: 'payer-1',
    checkoutStartedBy: 'starter-1',
    ...overrides,
  })
}

const INTERVALS: Readonly<Record<string, BillingInterval>> = {
  'price-month': 'month',
  'price-year': 'year',
}

/**
 * The rules' context for an active workspace.
 * @param overrides - What to change.
 * @returns The context.
 */
function context(overrides: Partial<BillingAnalyticsContext> = {}): BillingAnalyticsContext {
  return {
    isWorkspaceActive: true,
    intervalOf: (priceId) => (priceId === null ? undefined : INTERVALS[priceId]),
    ...overrides,
  }
}

/**
 * The event types a change sends, in order.
 * @param before - The row before.
 * @param after - The row after.
 * @param source - What made the change.
 * @param rules - The rules' context.
 * @returns The types.
 */
function typesOf(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: Parameters<typeof billingDiffEvents>[2] = 'webhook',
  rules: BillingAnalyticsContext = context()
): string[] {
  return billingDiffEvents(before, after, source, rules).map((event) => event.detail.type)
}

describe('billingDiffEvents', () => {
  it('sends nothing for a write that changes nothing an event reports', () => {
    expect(billingDiffEvents(paying(), paying({ syncedAt: NOW }), 'webhook', context())).toEqual([])
  })

  it('activates a new subscription with its interval, attributed to the checkout starter', () => {
    const events = billingDiffEvents(
      row({ checkoutStartedBy: 'starter-1' }),
      paying({ priceId: 'price-year', payerUserId: null }),
      'confirm',
      context()
    )
    expect(events).toEqual([
      { detail: { type: 'subscription_activated', interval: 'year' }, attribution: 'checkout' },
    ])
  })

  it('activates an upgrade during a trial without ending the trial as a downgrade', () => {
    expect(typesOf(row({ state: 'trialing' }), paying())).toEqual(['subscription_activated'])
  })

  it('renews when the paid period moves forward on the same subscription', () => {
    const events = billingDiffEvents(
      paying(),
      paying({ currentPeriodEnd: NEXT_PERIOD_END }),
      'webhook',
      context()
    )
    expect(events).toEqual([{ detail: { type: 'subscription_renewed' }, attribution: 'payer' }])
  })

  it('does not renew when the period end moves on a handover to the next subscription', () => {
    expect(
      typesOf(
        paying(),
        paying({ providerSubscriptionId: 'sub_2', currentPeriodEnd: NEXT_PERIOD_END })
      )
    ).toEqual([])
  })

  it.each([
    [{}, 'retrying'],
    [{ haltedAt: NOW }, 'halted'],
    [{ pausedAt: NOW }, 'paused'],
  ] as const)('reports a failed payment with its code (%o → %s)', (stamps, code) => {
    const events = billingDiffEvents(
      paying(),
      paying({ state: 'past_due', pastDueSince: NOW, ...stamps }),
      'webhook',
      context()
    )
    expect(events[0]).toEqual({
      detail: { type: 'payment_failed', failureCode: code },
      attribution: 'payer',
    })
  })

  it('reports a halt once, after the failure that started it', () => {
    const pastDue = paying({ state: 'past_due', pastDueSince: NOW })
    expect(
      typesOf(paying(), paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW }))
    ).toEqual(['payment_failed', 'subscription_halted'])
    expect(typesOf(pastDue, { ...pastDue, haltedAt: NOW })).toEqual(['subscription_halted'])
    expect(
      typesOf({ ...pastDue, haltedAt: NOW }, { ...pastDue, haltedAt: NOW, version: 2 })
    ).toEqual([])
  })

  it('recovers a past-due workspace that is active again, and does not call it a renewal', () => {
    const events = billingDiffEvents(
      paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW }),
      paying({ currentPeriodEnd: NEXT_PERIOD_END }),
      'webhook',
      context()
    )
    expect(events).toEqual([{ detail: { type: 'subscription_recovered' }, attribution: 'payer' }])
  })

  it.each([
    ['owner', true, 'owner'],
    ['staff', true, 'staff'],
    ['webhook', true, 'customer_bank'],
    ['reconcile', true, 'customer_bank'],
    ['job', false, 'suspension'],
  ] as const)(
    'schedules a cancel from %s (workspace active: %s) as by %s',
    (source, isWorkspaceActive, by) => {
      const events = billingDiffEvents(
        paying(),
        paying({ cancelAtPeriodEnd: true }),
        source,
        context({ isWorkspaceActive })
      )
      expect(events.map((event) => event.detail)).toContainEqual({
        type: 'subscription_cancel_scheduled',
        by,
      })
    }
  )

  it('does not call the cycle-end cancel of an interval switch a cancel', () => {
    const switching = paying({
      nextSubscriptionId: 'sub_2',
      nextPriceId: 'price-year',
      nextAuthenticatedAt: NOW,
    })
    expect(typesOf(switching, { ...switching, cancelAtPeriodEnd: true })).toEqual([])
  })

  it('counts an owner cancel before the first charge as a cancel', () => {
    const deferred = paying({ trialEndsAt: PERIOD_END })
    expect(
      typesOf(
        deferred,
        row({ state: 'trialing', trialEndsAt: PERIOD_END, payerUserId: 'payer-1' }),
        'owner'
      )
    ).toEqual(['subscription_cancel_scheduled'])
  })

  it('schedules an interval change once the next subscription is authenticated on another interval', () => {
    const before = paying({ nextSubscriptionId: 'sub_2', nextPriceId: 'price-year' })
    const events = billingDiffEvents(
      before,
      { ...before, nextAuthenticatedAt: NOW },
      'webhook',
      context()
    )
    expect(events).toEqual([
      { detail: { type: 'subscription_interval_change_scheduled' }, attribution: 'checkout' },
    ])
    const resubscribe = paying({ nextSubscriptionId: 'sub_2', nextPriceId: 'price-month' })
    expect(typesOf(resubscribe, { ...resubscribe, nextAuthenticatedAt: NOW })).toEqual([])
  })

  it('ends a lapsed trial and downgrades it, both attributed to the trial owner', () => {
    const events = billingDiffEvents(
      row({ state: 'trialing', trialEndsAt: NOW }),
      row({ trialEndsAt: NOW }),
      'job',
      context()
    )
    expect(events).toEqual([
      { detail: { type: 'trial_ended' }, attribution: 'trial' },
      {
        detail: { type: 'downgraded_to_free', downgradeCause: 'trial_ended' },
        attribution: 'trial',
      },
    ])
  })

  it.each([
    [paying({ state: 'past_due', haltedAt: NOW }), 'job', true, 'payment_failed'],
    [paying({ cancelAtPeriodEnd: true }), 'job', true, 'cancelled'],
    [paying(), 'staff', true, 'staff'],
    [paying(), 'job', false, 'lifecycle'],
  ] as const)(
    'downgrades a paying workspace to Free with its cause (%#)',
    (before, source, isWorkspaceActive, cause) => {
      const events = billingDiffEvents(
        before,
        row({ payerUserId: 'payer-1' }),
        source,
        context({ isWorkspaceActive })
      )
      expect(events).toContainEqual({
        detail: { type: 'downgraded_to_free', downgradeCause: cause },
        attribution: 'payer',
      })
    }
  )

  it('reports a reconcile repair with the first column it changed', () => {
    const events = billingDiffEvents(
      paying(),
      paying({ currentPeriodEnd: NEXT_PERIOD_END }),
      'reconcile',
      context()
    )
    expect(events).toEqual([
      { detail: { type: 'subscription_renewed' }, attribution: 'payer' },
      { detail: { type: 'billing_reconciled', field: 'current_period_end' }, attribution: 'payer' },
    ])
    expect(billingDiffEvents(row(), paying(), 'reconcile', context()).at(-1)?.detail).toEqual({
      type: 'billing_reconciled',
      field: 'state',
    })
  })

  it('reports no reconcile repair for a reconcile that changed nothing visible', () => {
    expect(typesOf(paying(), paying({ syncedAt: NOW }), 'reconcile')).toEqual([])
  })
})
