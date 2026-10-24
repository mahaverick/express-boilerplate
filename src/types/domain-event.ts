/**
 * @file The in-process domain events a service emits once its own
 * transaction has committed (domain-events.service.ts), and the context each
 * subscriber receives with one.
 */
import type { BillingInterval, BillingState, PlanKey } from '@/constants/billing.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { DowngradeCause } from '@/utilities/billing-transitions.utilities'

/**
 * How a user signed up or signed in.
 */
export type SignInMethod = 'link' | 'google' | 'passkey'

/**
 * Why a workspace's payment stopped: the provider still retries
 * (`retrying`), it gave up (`halted`), or the payer paused the mandate in
 * their bank or UPI app (`paused`).
 */
type PaymentFailureCode = 'retrying' | 'halted' | 'paused'

/**
 * Who scheduled a subscription's cancel: an owner in Billing, the payer
 * through their bank or UPI app (the provider reported a cancel the app did
 * not make), staff, or the workspace's suspension or archive.
 */
export type CancelScheduledBy = 'owner' | 'customer_bank' | 'staff' | 'suspension'

/**
 * What every billing event carries: the workspace, who it is attributed to,
 * and the workspace's plan and billing state once the change is made.
 */
interface BillingEventBase {
  tenantId: string
  /**
   * The member whose own action this is (an owner starting a checkout, a
   * member refused a feature); null when no member acted here.
   */
  userId: string | null
  /**
   * The person a change no member made here is attributed to, such as the
   * owner who started the checkout or the payer; null when no person is
   * known, which makes it a system event.
   */
  attributedUserId: string | null
  plan: PlanKey
  billingState: BillingState
  /**
   * Fixes this occurrence: a second event with the same key writes nothing,
   * and PostHog receives the same `uuid` for it.
   */
  dedupeKey?: string
  at: Date
}

/**
 * What tells one billing event from another: its type and its own fields.
 */
export type BillingEventDetail =
  | { type: 'trial_started' }
  | { type: 'trial_reminder_sent'; daysLeft: number }
  | { type: 'trial_extended'; days: number }
  | { type: 'trial_ended' }
  | { type: 'plan_limit_approaching'; key: string; used: number; limit: number }
  | {
      type: 'plan_limit_reached'
      key: string
      /**
       * The use and cap a member saw; absent for an invitee refused at the
       * door, who is never told the workspace's use.
       */
      usage?: { used: number; limit: number }
    }
  | { type: 'plan_feature_blocked'; key: string }
  | { type: 'upgrade_requested'; key: string | null; surface: string }
  | { type: 'upgrade_request_fulfilled' }
  | {
      type: 'checkout_started'
      interval: BillingInterval
      amountMinor: number
      currency: string
      duringTrial: boolean
    }
  | { type: 'checkout_confirmed' }
  | { type: 'subscription_activated'; interval: BillingInterval | null }
  | { type: 'subscription_renewed' }
  | { type: 'payment_failed'; failureCode: PaymentFailureCode }
  | { type: 'subscription_recovered' }
  | { type: 'subscription_halted' }
  | { type: 'subscription_cancel_scheduled'; by: CancelScheduledBy }
  | { type: 'subscription_interval_change_scheduled' }
  | { type: 'downgraded_to_free'; downgradeCause: DowngradeCause }
  | { type: 'payer_left' }
  | { type: 'duplicate_subscription_refunded' }
  | { type: 'billing_reconciled'; field: string }
  | { type: 'dispute_opened' }

/**
 * A billing event: a workspace's plan or billing changed, or the plan
 * refused something. Each joins its workspace's group.
 */
export type BillingDomainEvent = BillingEventBase & BillingEventDetail

/**
 * The product events: what a user or tenant did that the audit log does not
 * record, forwarded to analytics (analytics-forwarder.service.ts). The
 * user-level ones carry no `tenantId`. `onboarding_step_completed` is
 * emitted only for completions that are not audited; a staff completion
 * reaches analytics from its audit entry instead.
 */
export type ProductDomainEvent =
  | { type: 'user_signed_up'; userId: string; method: SignInMethod; at: Date }
  | { type: 'user_signed_in'; userId: string; method: SignInMethod; at: Date }
  | { type: 'user_signed_out'; userId: string; at: Date }
  | { type: 'other_sessions_revoked'; userId: string; at: Date }
  | { type: 'email_verified'; userId: string; at: Date }
  | {
      type: 'onboarding_step_completed'
      tenantId: string
      /**
       * The member whose action completed it; null for the reconcile script.
       */
      userId: string | null
      stepKey: string
      how: 'auto' | 'manual'
      required: boolean
      at: Date
    }
  | BillingDomainEvent

/**
 * Something that happened in a tenant or to a user, as its emitter saw it
 * after commit.
 */
export type DomainEvent =
  | ProductDomainEvent
  | {
      type: 'tenant_created'
      tenantId: string
      /**
       * The creating owner; null for a tenant staff created, which has no member yet.
       */
      ownerId: string | null
      at: Date
    }
  | { type: 'tenant_settings_updated'; tenantId: string; actorId: string; at: Date }
  | { type: 'teammate_invited'; tenantId: string; actorId: string; at: Date }
  | {
      type: 'invitation_accepted'
      tenantId: string
      userId: string
      role: MembershipRole
      /**
       * Whether the tenant had no other member when this one joined.
       */
      wasFirstMember: boolean
      at: Date
    }

/**
 * One of the event types.
 */
export type DomainEventType = DomainEvent['type']

/**
 * The event of one type.
 */
export type DomainEventOf<TType extends DomainEventType> = Extract<DomainEvent, { type: TType }>

/**
 * How the actor reached the tenant: as a member, or through their platform
 * role. A user-level event is always `member`: the user acted for themselves.
 */
export type DomainEventAccess = 'member' | 'platform'

/**
 * What a subscriber receives alongside the event.
 */
export interface DomainEventContext {
  access: DomainEventAccess
}

/**
 * A subscriber for one event type. It may be async; a throw or rejection is
 * logged and goes no further.
 */
export type DomainEventHandler<TType extends DomainEventType> = (
  event: DomainEventOf<TType>,
  context: DomainEventContext
) => void | Promise<void>
