/**
 * @file The inputs of the analytics event builder
 * (analytics-event-builder.service.ts) that no table row already describes.
 */
import type { BillingInterval, BillingState } from '@/constants/billing.constants'
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
 * The tenant columns behind a tenant group's PostHog properties. The drainer
 * reads them when it sends a `$groupidentify` marker (`resolveGroupMarkers`,
 * analytics-group-marker.service.ts); the outbox row stores only the id.
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
  /**
   * The billing behind the group's plan properties; null for a tenant with
   * no billing row (the platform tenant). Absent where only the id is used,
   * as on an audit entry's marker.
   */
  billing?: TenantGroupBilling | null
}

/**
 * The billing facts of a tenant group, read when its marker is sent.
 */
export interface TenantGroupBilling {
  state: BillingState
  /**
   * The interval of the current price; null with none.
   */
  interval: BillingInterval | null
  trialStartedAt: Date | null
  trialEndsAt: Date | null
  /**
   * The name of the plan a trial gives (Paid), for a tenant that had a trial.
   */
  trialPlanName: string | null
  /**
   * Upgrade requests neither fulfilled nor expired.
   */
  openUpgradeRequests: number
  /**
   * When the tenant last started paying, for a paying tenant; else null.
   */
  paidSince: Date | null
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
   * Adds a `$groupidentify` marker for this tenant; only its id is stored.
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
