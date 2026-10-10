/**
 * @file What `/platform/emails*` and `/platform/email-suppressions*` return.
 * Apex mirrors these in its `src/types/api.types.ts`.
 */
import type {
  BounceKind,
  EmailEventType,
  EmailMessageGroup,
  EmailMessageStatus,
  FailureOrigin,
  SenderClass,
  SuppressionReason,
} from '@/constants/email.constants'
import type { FrontendApp } from '@/constants/frontend.constants'
import type { StatsRange } from '@/constants/platform.constants'
import type { EmailLogStatus } from '@/database/models/email-log.model'

/**
 * A person a message or suppression points at: their id and display name
 * (first and last name, or the address when they have neither).
 */
export interface EmailPerson {
  id: string
  name: string
}

/**
 * The tenant a message belongs to.
 */
interface EmailTenant {
  id: string
  name: string
  slug: string
}

/**
 * One logical email as the staff list shows it. `user` and `tenant` are null
 * when the message has none or the row was purged. `canResend` is computed
 * for the staff member asking; the resend endpoint enforces its own checks.
 */
export interface EmailMessageSummary {
  id: string
  recipient: string
  templateKey: string
  status: EmailMessageStatus
  senderClass: SenderClass
  createdAt: Date
  statusUpdatedAt: Date
  user: EmailPerson | null
  tenant: EmailTenant | null
  canResend: boolean
}

/**
 * A page of messages, newest first, and the opaque cursors either side of it
 * (null at each end).
 */
export interface EmailMessagePage {
  messages: EmailMessageSummary[]
  nextCursor: string | null
  prevCursor: string | null
}

/**
 * One send attempt (an `email_logs` row).
 */
interface EmailAttemptView {
  id: string
  status: EmailLogStatus
  errorCode: string | null
  createdAt: Date
}

/**
 * One provider event. Never a raw payload or a clicked URL.
 */
interface EmailEventView {
  id: string
  provider: string
  type: EmailEventType
  bounceKind: BounceKind | null
  detail: string | null
  occurredAt: Date
}

/**
 * One logical email with its attempts, provider events, the recipient's
 * active suppression, and the resend chain either side of it.
 */
export interface EmailMessageDetail extends EmailMessageSummary {
  linkApp: FrontendApp | null
  failureOrigin: FailureOrigin | null
  attempts: EmailAttemptView[]
  events: EmailEventView[]
  suppression: { id: string; reason: SuppressionReason; createdAt: Date } | null
  resentFromId: string | null
  resentAsIds: string[]
}

/**
 * A stored template re-rendered for staff, links masked. `partial` is true
 * when a stored preview variable was missing (a legacy row) and shows as
 * the mask; the masked token and the inviter's placeholder never set it.
 */
export interface EmailPreview {
  subject: string
  html: string
  text: string
  partial: boolean
}

/**
 * Messages per disjoint status group.
 */
export type EmailGroupCounts = Record<EmailMessageGroup, number>

/**
 * A rate and the counts behind it. `value` is a fraction from 0 to 1, or
 * null when it cannot be known: no denominator, or a provider-dependent rate
 * with no provider events in the range.
 */
export interface EmailRate {
  value: number | null
  numerator: number
  denominator: number
}

/**
 * One row of the by-template or by-domain table.
 */
interface EmailBreakdownRow {
  key: string
  messages: number
  undelivered: number
  complained: number
}

/**
 * Deliverability over a range of UTC days, by message creation day.
 */
export interface EmailHealth {
  range: StatsRange
  totals: EmailGroupCounts & { messages: number; providerEvents: number }
  rates: {
    undeliveredRate: EmailRate
    deliveredRate: EmailRate
    bounceRate: EmailRate
    complaintRate: EmailRate
    openRate: EmailRate
    clickRate: EmailRate
  }
  days: (EmailGroupCounts & { date: string })[]
  byTemplate: EmailBreakdownRow[]
  byDomain: EmailBreakdownRow[]
}

/**
 * One suppression as the staff list shows it. `sourceMessageId` is the
 * message whose event caused it, null once that event is gone.
 */
export interface EmailSuppressionView {
  id: string
  address: string
  reason: SuppressionReason
  sourceMessageId: string | null
  createdAt: Date
  liftedAt: Date | null
  liftedBy: EmailPerson | null
  liftReason: string | null
}

/**
 * A page of suppressions, newest first, and the cursors either side of it.
 */
export interface EmailSuppressionPage {
  suppressions: EmailSuppressionView[]
  nextCursor: string | null
  prevCursor: string | null
}
