/**
 * @file What `/platform/onboarding*` and `/platform/tenants/:id/onboarding*`
 * return. Apex mirrors these in its `src/types/api.types.ts`.
 */
import type {
  OnboardingRange,
  OnboardingScope,
  OnboardingSource,
  OnboardingState,
} from '@/constants/onboarding.constants'
import type { MembershipRole, TenantLifecycleState } from '@/constants/tenant.constants'

/**
 * A person an onboarding read names: their id and display name (first and
 * last name, or the address when they have neither).
 */
export interface OnboardingPerson {
  id: string
  name: string
}

/**
 * A registry step by key and title.
 */
export interface OnboardingStepSummary {
  key: string
  title: string
}

/**
 * One registry step in the funnel: how many tenants of the cohort have it
 * done (a member step counts once any active owner has done it), and how
 * many of those were completed by staff.
 */
export interface OnboardingFunnelStep {
  key: string
  title: string
  scope: OnboardingScope
  required: boolean
  completed: number
  staffCompleted: number
}

/**
 * The funnel over the active, tracked tenants whose onboarding started in
 * the range (`from` to the moment of the read).
 */
export interface OnboardingFunnel {
  range: OnboardingRange
  from: Date
  totals: {
    started: number
    inProgress: number
    stuck: number
    complete: number
    dismissed: number
  }
  /**
   * `complete / started`, a fraction from 0 to 1, or null when none started.
   */
  completionRate: number | null
  /**
   * Every active, live, tracked tenant, whatever the range and whether or
   * not its first owner has joined. Zero means no tenant has been created
   * since onboarding tracking began.
   */
  trackedTenants: number
  steps: OnboardingFunnelStep[]
}

/**
 * One tenant in the staff onboarding list. `daysStuck` is the whole days
 * since `lastProgressAt`, set only for a stuck tenant. `owners` are the
 * tenant's active owners.
 */
export interface OnboardingTenantRow {
  id: string
  name: string
  slug: string
  state: OnboardingState
  owners: OnboardingPerson[]
  startedAt: Date | null
  lastProgressAt: Date | null
  completedAt: Date | null
  daysStuck: number | null
  nextStep: OnboardingStepSummary | null
  requiredDone: number
  requiredTotal: number
}

/**
 * A page of the onboarding list and the opaque cursors either side of it
 * (null at each end).
 */
export interface OnboardingTenantPage {
  tenants: OnboardingTenantRow[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One live member's own completion of a member step.
 */
export interface OnboardingMemberStatus {
  user: OnboardingPerson
  role: MembershipRole
  completedAt: Date | null
  source: OnboardingSource | null
}

/**
 * One registry step on the staff tenant tab. For a member step the
 * top-level completion is the earliest by an active owner, and `members`
 * lists every live member's own; for a tenant step `members` is null.
 * `completedBy` is null for an automatic completion and for one whose
 * actor was purged ("by a removed user" when `source` is `staff`).
 * `canMarkComplete` ignores the caller's role: Apex also checks it is an
 * admin.
 */
export interface OnboardingStepDetail {
  key: string
  title: string
  description: string
  scope: OnboardingScope
  kind: 'auto' | 'manual'
  required: boolean
  completedAt: Date | null
  source: OnboardingSource | null
  completedBy: OnboardingPerson | null
  reason: string | null
  members: { completed: number; total: number; entries: OnboardingMemberStatus[] } | null
  canMarkComplete: boolean
}

/**
 * Why a reminder cannot be sent now, as the remind endpoint's 409 code.
 */
export type OnboardingReminderBlock =
  'tenant_state_conflict' | 'not_in_progress' | 'no_owner' | 'reminded_recently'

/**
 * One reminder a staff member sent, read from its `onboarding.reminder_sent`
 * audit entry. `sentBy` is null once the staff member was purged.
 * `messageIds` are the SP3 `email_messages` rows, one per queued email.
 */
export interface OnboardingReminderView {
  id: string
  sentAt: Date
  sentBy: OnboardingPerson | null
  reason: string
  recipientCount: number
  emailDomains: string[]
  messageIds: string[]
}

/**
 * Whether the remind endpoint would accept a reminder now (the caller's
 * role aside), and why not; the domains of the active owners it would mail.
 */
export interface OnboardingReminderAvailability {
  canSend: boolean
  blockedBy: OnboardingReminderBlock | null
  lastSentAt: Date | null
  nextAllowedAt: Date | null
  recipientCount: number
  emailDomains: string[]
}

/**
 * One customer tenant's onboarding, in any lifecycle state, for the staff
 * tenant tab.
 */
export interface TenantOnboardingDetail {
  tenant: { id: string; name: string; slug: string; lifecycleState: TenantLifecycleState }
  state: OnboardingState
  startedAt: Date | null
  lastProgressAt: Date | null
  completedAt: Date | null
  dismissedAt: Date | null
  dismissedBy: OnboardingPerson | null
  daysStuck: number | null
  requiredDone: number
  requiredTotal: number
  nextStep: OnboardingStepSummary | null
  steps: OnboardingStepDetail[]
  reminder: OnboardingReminderAvailability
  reminders: OnboardingReminderView[]
}

/**
 * What a reminder reports: whether every owner's email was queued, and how
 * many active owners it addressed.
 */
export interface OnboardingReminderResult {
  emailSent: boolean
  recipientCount: number
}
