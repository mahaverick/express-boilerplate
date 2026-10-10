/**
 * @file The shapes of the staff timelines: what a request asks for, one row
 * as the API returns it, and a page. Rows are built only from the fixed
 * allowlist in timeline-mapper.service.ts.
 */
import type { AuditAccess } from '@/constants/audit.constants'
import type {
  TimelinePropertyKey,
  TimelineRange,
  TimelineView,
} from '@/constants/timeline.constants'

/**
 * Whose timeline: a user's or a tenant's.
 */
export type TimelineKind = 'user' | 'tenant'

/**
 * A decoded page cursor: the last row's timestamp exactly as PostHog returned
 * it (microseconds, never parsed into a `Date`) and its uuid.
 */
export interface TimelineCursor {
  t: string
  u: string
}

/**
 * The validated query of a timeline request. `before` is the opaque cursor,
 * still encoded; absent on a first page.
 */
export interface TimelineQueryInput {
  range: TimelineRange
  view: TimelineView
  before?: string | undefined
}

/**
 * Where an event came from: a server source, or `browser` for anything
 * posthog-js captured.
 */
export type TimelineSource = 'audit' | 'product' | 'email' | 'browser'

/**
 * The app that sent an event.
 */
export type TimelineApp = 'api' | 'react' | 'apex'

/**
 * The allowlisted event properties a row carries, each a string, number or boolean.
 */
export type TimelineRowProperties = Partial<Record<TimelinePropertyKey, string | number | boolean>>

/**
 * One event on a timeline. `source`, `access` and the `target_*` props are
 * server facts only when `verified`: an unverified row has `source:
 * 'browser'`, `access: null` and no target.
 */
export interface TimelineRow {
  uuid: string
  event: string
  /**
   * PostHog's timestamp string, verbatim.
   */
  timestamp: string
  distinctId: string
  source: TimelineSource
  access: AuditAccess | null
  app: TimelineApp | null
  sessionId: string | null
  traceId: string | null
  /**
   * The pathname of `$current_url`: no query, no fragment.
   */
  path: string | null
  /**
   * The clicked element's text, on `$autocapture` and `$rageclick` only.
   */
  elementText: string | null
  props: TimelineRowProperties
  /**
   * Whether the row's `server_sig` verifies (analytics-signature.service.ts).
   */
  verified: boolean
  /**
   * The event's `$groups.tenant`, as PostHog stored it.
   */
  tenant: string | null
}

/**
 * The user who caused a tenant timeline row. `displayName` is the full
 * name, else the email; null when no user row has that id (a purged user,
 * or an anonymous browser id).
 */
export interface TimelineActor {
  id: string
  displayName: string | null
}

/**
 * A tenant timeline row: a row and its actor, null for a `system` row.
 */
export type TenantTimelineRow = TimelineRow & { actor: TimelineActor | null }

/**
 * The PostHog deep links of a page; `replay` holds `{sessionId}` for the
 * client to fill in.
 */
interface TimelinePageLinks {
  person: string | null
  group: string | null
  replay: string
}

/**
 * One timeline page, or `configured: false` when this environment has no
 * PostHog personal key.
 */
export type TimelinePage =
  | { configured: false }
  | {
      configured: true
      rows: TimelineRow[] | TenantTimelineRow[]
      nextCursor: string | null
      links: TimelinePageLinks
    }
