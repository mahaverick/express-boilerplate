/**
 * @file The inputs of the analytics event builder
 * (analytics-event-builder.service.ts) that no table row already describes.
 */
import type { BounceKind, EmailEventType } from '@/constants/email.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { SignInMethod } from '@/types/domain-event'

/**
 * What links a server event to its request: the active OTel span, and the
 * browser's PostHog session from `X-POSTHOG-SESSION-ID`, and the
 * authenticated user who sent it. Each is absent when there is none.
 */
export interface AnalyticsContext {
  traceId?: string
  spanId?: string
  posthogSessionId?: string
  /**
   * The authenticated user of the request. When present, only this user's
   * events may carry the browser session id; without one, only the user's
   * own sign-in, sign-up and sign-out may.
   */
  userId?: string
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

/**
 * One stored `email_events` row and the message it belongs to, as
 * `buildEmailEvent` reads them. Never the recipient, subject or detail.
 */
export interface EmailEventInput {
  type: EmailEventType
  /**
   * The `email_messages` id.
   */
  messageId: string
  templateKey: string
  userId: string | null
  tenantId: string | null
  bounceKind: BounceKind | null
  occurredAt: Date
}

/**
 * The person properties only the server sets, on `user_signed_up` and
 * `user_signed_in`, read when the event is forwarded. The browser never
 * sets them, so nobody can forge `is_staff` from devtools.
 */
export interface ServerPersonProperties {
  isStaff: boolean
  platformRole: MembershipRole | null
  isEmailVerified: boolean
  /**
   * How the user signed up or signed in this time.
   */
  authProvider: SignInMethod
  createdAt: Date
}

/**
 * What `buildProductEvent` adds to a sign-up or sign-in, read when the event
 * is forwarded.
 */
export interface ProductEventExtras {
  /**
   * The user's server-owned person properties, for `user_signed_up` and `user_signed_in`.
   */
  person?: ServerPersonProperties
  /**
   * For `user_signed_up`: whether a pending, unexpired invitation named the
   * address when the account was created.
   */
  isViaInvitation?: boolean
}
