/**
 * @file Which billing emails a committed change sends, read from the row
 * before and after it: each transition once, nothing for a write that changes
 * no state, and the cause of a move to Free from the source and the row it
 * left.
 */
import { describe, expect, it } from 'vite-plus/test'
import type { BillingInterval } from '@/constants/billing.constants'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import {
  billingTransitions,
  type TransitionContext,
} from '@/utilities/billing-transitions.utilities'

const NOW = new Date('2026-11-01T00:00:00.000Z')
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z')

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
    providerSubscriptionId: 'sub_1',
    currentPeriodEnd: PERIOD_END,
    version: 2,
    ...overrides,
  })
}

/**
 * The interval each test price bills.
 */
const INTERVALS = new Map<string, BillingInterval>([
  ['price-month', 'month'],
  ['price-year', 'year'],
])

const CONTEXT: TransitionContext = {
  isWorkspaceActive: true,
  intervalOf: (priceId) => (priceId === null ? undefined : INTERVALS.get(priceId)),
}

/**
 * The transition kinds and causes for one change.
 * @param before - The row before.
 * @param after - The row after.
 * @param source - What made the change.
 * @param context - The workspace facts.
 * @returns Each transition as `kind` or `kind:cause`.
 */
function kinds(
  before: TenantBillingRecord,
  after: TenantBillingRecord,
  source: Parameters<typeof billingTransitions>[2] = 'webhook',
  context: TransitionContext = CONTEXT
): string[] {
  return billingTransitions(before, after, source, context).map((transition) => {
    if (transition.kind === 'moved_to_free') return `${transition.kind}:${transition.cause}`
    if (transition.kind === 'payment_failed') return `${transition.kind}:${transition.stoppedBy}`
    return transition.kind
  })
}

describe('billingTransitions', () => {
  it('welcomes a workspace to Paid when a new subscription becomes current', () => {
    expect(kinds(row(), paying())).toEqual(['paid_welcome'])
    expect(kinds(row({ state: 'trialing', planId: 'plan-paid' }), paying())).toEqual([
      'paid_welcome',
    ])
  })

  it('sends no welcome for a recovery on the same subscription', () => {
    const pastDue = paying({ state: 'past_due', pastDueSince: NOW })
    expect(kinds(pastDue, paying())).toEqual([])
  })

  it('sends the payment failure once, when the provider halts the subscription', () => {
    const pastDue = paying({ state: 'past_due', pastDueSince: NOW })
    const halted = paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW })
    expect(kinds(paying(), pastDue)).toEqual([])
    expect(kinds(pastDue, halted)).toEqual(['payment_failed:halted'])
    expect(kinds(halted, halted)).toEqual([])
  })

  it('warns once when the subscription is paused, which starts the grace period too', () => {
    const paused = paying({ pausedAt: NOW })
    expect(kinds(paying(), paused)).toEqual(['payment_failed:paused'])
    expect(kinds(paused, paused)).toEqual([])
  })

  it('warns again for a second halt after a recovery', () => {
    const halted = paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW })
    const later = new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000)
    expect(kinds(halted, paying())).toEqual([])
    expect(kinds(paying(), { ...halted, haltedAt: later, pastDueSince: later })).toEqual([
      'payment_failed:halted',
    ])
  })

  it('confirms a cancel at the period end', () => {
    expect(kinds(paying(), paying({ cancelAtPeriodEnd: true }), 'owner')).toEqual([
      'paid_cancelled',
    ])
  })

  it('sends no cancel confirmation when a scheduled switch ends the current subscription', () => {
    const switching = paying({
      nextSubscriptionId: 'sub_2',
      nextPriceId: 'price-year',
      nextAuthenticatedAt: NOW,
    })
    expect(kinds(switching, { ...switching, cancelAtPeriodEnd: true })).toEqual([])
  })

  it('sends no cancel confirmation for a suspended or archived workspace', () => {
    const context = { ...CONTEXT, isWorkspaceActive: false }
    expect(kinds(paying(), paying({ cancelAtPeriodEnd: true }), 'job', context)).toEqual([])
  })

  it('confirms an interval switch once the next subscription is authenticated', () => {
    const scheduled = paying({ nextSubscriptionId: 'sub_2', nextPriceId: 'price-year' })
    expect(kinds(scheduled, { ...scheduled, nextAuthenticatedAt: NOW })).toEqual([
      'interval_switch_scheduled',
    ])
  })

  it('sends nothing for a resubscribe on the same interval', () => {
    const cancelling = paying({ cancelAtPeriodEnd: true })
    const resubscribed = {
      ...cancelling,
      nextSubscriptionId: 'sub_2',
      nextPriceId: 'price-month',
    }
    expect(kinds(resubscribed, { ...resubscribed, nextAuthenticatedAt: NOW })).toEqual([])
  })

  it.each([
    ['a lapsed trial', row({ state: 'trialing', planId: 'plan-paid' }), 'job', 'trial_ended'],
    [
      'a grace period that ended',
      paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW }),
      'job',
      'payment_failed',
    ],
    ['a paused subscription', paying({ pausedAt: NOW }), 'webhook', 'payment_failed'],
    ['a cancelled period', paying({ cancelAtPeriodEnd: true }), 'job', 'cancelled'],
  ] as const)('names the cause of a move to Free after %s', (_name, before, source, cause) => {
    expect(kinds(before, row({ version: 9 }), source)).toEqual([`moved_to_free:${cause}`])
  })

  it('names staff the cause only for a staff cancel, never for a staff resync', () => {
    const staffCancel = { ...CONTEXT, isStaffCancel: true }
    expect(kinds(paying(), row({ version: 9 }), 'staff', staffCancel)).toEqual([
      'moved_to_free:staff',
    ])
    expect(kinds(paying({ state: 'past_due', pastDueSince: NOW }), row(), 'staff')).toEqual([
      'moved_to_free:payment_failed',
    ])
    expect(kinds(paying({ cancelAtPeriodEnd: true }), row(), 'staff')).toEqual([
      'moved_to_free:cancelled',
    ])
    // The flag alone, from a source other than staff, is not a staff cancel.
    expect(kinds(paying(), row(), 'webhook', staffCancel)).toEqual(['moved_to_free:cancelled'])
  })

  it('asks a suspended or archived workspace to act in Billing for nothing', () => {
    const context = { ...CONTEXT, isWorkspaceActive: false }
    const trial = row({ state: 'trialing', planId: 'plan-paid' })
    const halted = paying({ state: 'past_due', pastDueSince: NOW, haltedAt: NOW })
    expect(kinds(trial, row(), 'job', context)).toEqual([])
    expect(kinds(paying(), halted, 'webhook', context)).toEqual([])
    expect(kinds(row(), paying(), 'webhook', context)).toEqual([])
    const scheduled = paying({ nextSubscriptionId: 'sub_2', nextPriceId: 'price-year' })
    expect(
      kinds(scheduled, { ...scheduled, nextAuthenticatedAt: NOW }, 'webhook', context)
    ).toEqual([])
  })

  it('names a suspension or archive as the cause for a workspace that is not active', () => {
    const context = { ...CONTEXT, isWorkspaceActive: false }
    expect(kinds(paying({ cancelAtPeriodEnd: true }), row(), 'job', context)).toEqual([
      'moved_to_free:lifecycle',
    ])
  })

  it('sends nothing when the same row is written again', () => {
    for (const same of [row(), paying(), paying({ cancelAtPeriodEnd: true })]) {
      expect(kinds(same, same)).toEqual([])
    }
  })

  it('sends nothing when a deferred start is cancelled back to its trial', () => {
    const deferred = paying({ state: 'active', trialEndsAt: PERIOD_END })
    const backToTrial = row({ state: 'trialing', planId: 'plan-paid', trialEndsAt: PERIOD_END })
    expect(kinds(deferred, backToTrial, 'owner')).toEqual([])
  })
})
