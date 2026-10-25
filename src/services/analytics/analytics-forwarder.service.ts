/**
 * @file Forwards the product domain events to the analytics outbox: one
 * subscriber per product event type, each building its row and inserting
 * it on the pool, after the emitter's transaction has committed. A sign-up
 * or sign-in also reads the user's server-owned person properties, and a
 * sign-up whether a redeemable invitation was waiting for the address.
 * Every subscriber returns at once while analytics is disabled, so an
 * unconfigured deployment runs no extra query. The four tenant domain
 * events are not forwarded here: their audit entries already are. A
 * billing event also queues its workspace's group marker.
 */
import { isAnalyticsEnabled } from '@/configs/analytics.config'
import { PRODUCT_EVENTS } from '@/constants/analytics.constants'
import type { NewAnalyticsOutboxRow } from '@/database/models/analytics-outbox.model'
import { redactedForLog } from '@/errors/postgres-errors'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { currentAnalyticsContext } from '@/services/analytics/analytics-context.service'
import {
  buildProductEvent,
  buildTenantGroupIdentify,
  dedupedRowId,
  isBillingEvent,
} from '@/services/analytics/analytics-event-builder.service'
import { enqueueAnalytics } from '@/services/analytics/analytics-outbox.service'
import { db } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { logger } from '@/services/logger.service'
import type { ProductEventExtras } from '@/types/analytics'
import type {
  DomainEventContext,
  DomainEventOf,
  ProductDomainEvent,
  SignInMethod,
} from '@/types/domain-event'

const userRepository = new UserRepository()
const userMembershipRepository = new UserMembershipRepository()
const tenantInvitationRepository = new TenantInvitationRepository()

/**
 * What a sign-up or sign-in adds: the user's server-owned person properties
 * and, for a sign-up, whether a redeemable invitation named the address.
 * Empty when the user is gone or a read fails: the event is still sent.
 * @param userId - The user.
 * @param method - How they signed up or in.
 * @param isSignUp - Whether to look for an invitation.
 * @returns The extras.
 */
async function readSignInExtras(
  userId: string,
  method: SignInMethod,
  isSignUp: boolean
): Promise<ProductEventExtras> {
  try {
    const user = await userRepository.findById(userId)
    if (!user) return {}
    const platformRole = await userMembershipRepository.findPlatformRole(userId)
    const extras: ProductEventExtras = {
      person: {
        isStaff: platformRole !== null,
        platformRole,
        isEmailVerified: user.emailVerifiedAt !== null,
        authProvider: method,
        createdAt: user.createdAt,
      },
    }
    if (isSignUp) {
      extras.isViaInvitation = await tenantInvitationRepository.hasRedeemableForEmail(user.email)
    }
    return extras
  } catch (error) {
    logger.warn('Analytics sign-in properties could not be read', {
      error: redactedForLog(error),
      userId,
    })
    return {}
  }
}

/**
 * The outbox rows of one product event: its row, and for a billing event
 * its workspace's `$groupidentify` marker, since the event changed the
 * workspace's plan, billing state or limit hits. A deduplicated event's
 * marker gets a row id fixed by the same key, so a repeat writes neither.
 * @param event - The product event.
 * @param access - How the actor reached the tenant.
 * @param extras - Person properties and the invitation flag, for a sign-up or sign-in.
 * @returns The rows, the event first.
 */
export function productEventRows(
  event: ProductDomainEvent,
  access: DomainEventContext['access'],
  extras: ProductEventExtras = {}
): NewAnalyticsOutboxRow[] {
  const analyticsContext = currentAnalyticsContext()
  const rows: NewAnalyticsOutboxRow[] = [buildProductEvent(event, analyticsContext, access, extras)]
  if (isBillingEvent(event)) {
    const marker = buildTenantGroupIdentify(
      { id: event.tenantId },
      analyticsContext,
      'product',
      event.at
    )
    rows.push(
      event.dedupeKey === undefined
        ? marker
        : { ...marker, id: dedupedRowId(`${event.dedupeKey}:group`) }
    )
  }
  return rows
}

/**
 * Forward one product event: build its rows (`productEventRows`), with the
 * extras of a sign-up or sign-in, and insert them on the pool.
 * `enqueueAnalytics` never throws.
 * @param event - The product event.
 * @param context - Its domain-event context.
 * @returns Resolves once the rows are written, skipped or their failure logged.
 */
async function forwardProductEvent(
  event: DomainEventOf<ProductDomainEvent['type']>,
  context: DomainEventContext
): Promise<void> {
  if (!isAnalyticsEnabled()) return
  const extras =
    event.type === 'user_signed_up' || event.type === 'user_signed_in'
      ? await readSignInExtras(event.userId, event.method, event.type === 'user_signed_up')
      : {}
  await enqueueAnalytics(productEventRows(event, context.access, extras), db)
}

/**
 * Subscribe the analytics forwarder to every product event type.
 * `createApp()` calls it; calling it again changes nothing.
 */
export function registerAnalyticsSubscribers(): void {
  for (const type of PRODUCT_EVENTS) subscribeDomainEvent(type, forwardProductEvent)
}
