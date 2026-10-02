/**
 * @file The in-process domain-event seam. A service calls `emitDomainEvent`
 * after its own transaction commits (no after-commit hook exists), and awaits
 * it: every subscriber has run by the time the request answers, so a client
 * that refetches sees what they did. A failing subscriber is logged and never
 * fails the emitter or the subscribers after it. Subscribers are registered
 * by `createApp()` (app.ts).
 */
import { redactedForLog } from '@/errors/postgres-errors'
import { logger } from '@/services/logger.service'
import type {
  DomainEvent,
  DomainEventAccess,
  DomainEventContext,
  DomainEventHandler,
  DomainEventType,
} from '@/types/domain-event'

/**
 * A handler as stored: each is only ever called with its own type's events,
 * which `subscribeDomainEvent` guarantees.
 */
type StoredHandler = (event: DomainEvent, context: DomainEventContext) => void | Promise<void>

const subscribers = new Map<DomainEventType, Set<StoredHandler>>()

/**
 * Subscribe a handler to one event type. Subscribing the same function twice
 * keeps one subscription, so building the app more than once in a process
 * (every test file does) never runs a handler twice.
 * @param type - The event type.
 * @param handler - Called with each event of that type, in subscription order.
 */
export function subscribeDomainEvent<TType extends DomainEventType>(
  type: TType,
  handler: DomainEventHandler<TType>
): void {
  const handlers = subscribers.get(type) ?? new Set<StoredHandler>()
  handlers.add(handler as StoredHandler)
  subscribers.set(type, handlers)
}

/**
 * Deliver an event to every subscriber of its type, one after another. Call
 * it after the transaction that made the change has committed. A subscriber
 * that throws or rejects is logged at error and skipped.
 * @param event - The event.
 * @param options - How the actor reached the tenant.
 * @param options.access - `'platform'` for an action taken through platform access; defaults to `'member'`.
 * @returns Resolves once every subscriber has settled; never rejects.
 */
export async function emitDomainEvent(
  event: DomainEvent,
  options: { access?: DomainEventAccess } = {}
): Promise<void> {
  const context: DomainEventContext = { access: options.access ?? 'member' }
  const handlers = [...(subscribers.get(event.type) ?? [])]
  for (const handler of handlers) {
    try {
      await handler(event, context)
    } catch (error) {
      logger.error('Domain event subscriber failed', {
        error: redactedForLog(error),
        eventType: event.type,
        tenantId: event.tenantId,
      })
    }
  }
}

/**
 * Remove every subscriber. Tests only: a test that subscribes its own
 * handler calls this afterwards and re-registers the app's subscribers.
 */
export function resetDomainEventSubscribers(): void {
  subscribers.clear()
}
