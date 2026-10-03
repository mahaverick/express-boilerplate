/**
 * @file The in-process domain events a service emits once its own
 * transaction has committed (domain-events.service.ts), and the context each
 * subscriber receives with one.
 */
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * How a user signed up or signed in.
 */
export type SignInMethod = 'password' | 'google'

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
  | { type: 'password_changed'; userId: string; at: Date }
  | { type: 'password_reset_completed'; userId: string; at: Date }
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
