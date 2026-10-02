/**
 * @file The in-process domain events a service emits once its own
 * transaction has committed (domain-events.service.ts), and the context each
 * subscriber receives with one.
 */
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * Something that happened in a tenant, as its emitter saw it after commit.
 */
export type DomainEvent =
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
 * How the actor reached the tenant: as a member, or through their platform role.
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
