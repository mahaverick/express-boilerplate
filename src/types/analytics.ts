/**
 * @file The inputs of the analytics event builder
 * (analytics-event-builder.service.ts) that no table row already describes.
 */
import type { MembershipRole } from '@/constants/tenant.constants'

/**
 * What links a server event to its request: the active OTel span, and the
 * browser's PostHog session from `X-POSTHOG-SESSION-ID`. Each is absent
 * when there is none.
 */
export interface AnalyticsContext {
  traceId?: string
  spanId?: string
  posthogSessionId?: string
}

/**
 * The tenant columns a `$groupidentify` row carries, read in the same
 * transaction as the change that prompted it.
 */
export interface TenantGroupSnapshot {
  id: string
  name: string
  /**
   * The tenant's lifecycle state.
   */
  status: string
  createdAt: Date
  isPlatform: boolean
}

/**
 * A user whose platform role an audited action may have changed, and the
 * role they hold once it commits; null when they are not staff.
 */
export interface StaffStatusSnapshot {
  userId: string
  platformRole: MembershipRole | null
}

/**
 * What `buildAuditEvents` adds beside the event itself.
 */
export interface AuditEventExtras {
  /**
   * Adds a `$groupidentify` row for this tenant.
   */
  tenant?: TenantGroupSnapshot
  /**
   * Adds a `$set` row updating this user's staff status.
   */
  staffStatus?: StaffStatusSnapshot
}
