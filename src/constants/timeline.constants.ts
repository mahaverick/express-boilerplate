/**
 * @file Fixed values of the staff timelines: the ranges and views the routes
 * accept, the page size, the cache and PostHog timeouts, the events the
 * queries leave out and the event properties a timeline row may carry.
 */

/**
 * The windows a timeline covers, newest event back.
 */
export const TIMELINE_RANGES = ['24h', '7d', '30d', '90d'] as const

/**
 * One of `TIMELINE_RANGES`.
 */
export type TimelineRange = (typeof TIMELINE_RANGES)[number]

/**
 * Each range in hours, the unit the query's `toIntervalHour` takes.
 */
export const TIMELINE_RANGE_HOURS: Readonly<Record<TimelineRange, number>> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
}

/**
 * `all` is every event, pageviews and clicks included; `key` leaves out every
 * event whose name starts with `$`.
 */
export const TIMELINE_VIEWS = ['all', 'key'] as const

/**
 * One of `TIMELINE_VIEWS`.
 */
export type TimelineView = (typeof TIMELINE_VIEWS)[number]

/**
 * The range a request without `range` gets.
 */
export const TIMELINE_DEFAULT_RANGE: TimelineRange = '7d'

/**
 * The view a request without `view` gets: the debugging view.
 */
export const TIMELINE_DEFAULT_VIEW: TimelineView = 'all'

/**
 * Rows per page. The query asks for one more, which only says whether
 * another page exists.
 */
export const TIMELINE_PAGE_SIZE = 100

/**
 * How long a mapped page stays in Redis.
 */
export const TIMELINE_CACHE_TTL_SECONDS = 30

/**
 * How long one staff member's view of one target in one view is audited
 * once: at most one `user.timeline_viewed` or `tenant.timeline_viewed` per
 * staff member, target and view in this window (`SET NX EX`).
 */
export const TIMELINE_AUDIT_THROTTLE_SECONDS = 600

/**
 * How long one call to PostHog's private API may take. A 90-day timeline
 * query took 2.6–5.6 s on a fresh project.
 */
export const TIMELINE_POSTHOG_TIMEOUT_MS = 15_000

/**
 * The longest `elementText` a row carries; longer text is cut to this.
 */
export const TIMELINE_ELEMENT_TEXT_MAX = 80

/**
 * Events no timeline lists: the two timeline-view and two errors-view audits
 * (so a page never shows itself or its sibling tab), exceptions (they have
 * their own Errors tab), and PostHog's identity, property and flag
 * bookkeeping.
 */
export const TIMELINE_EXCLUDED_EVENTS = [
  'user_timeline_viewed',
  'tenant_timeline_viewed',
  'user_errors_viewed',
  'tenant_errors_viewed',
  '$exception',
  '$identify',
  '$set',
  '$groupidentify',
  '$feature_flag_called',
  '$create_alias',
] as const

/**
 * The only event properties a timeline row's `props` may carry. Every other
 * property PostHog holds stays in PostHog.
 */
export const TIMELINE_PROP_KEYS = [
  'target_type',
  'target_id',
  'step_key',
  'how',
  'required',
  'method',
  'via_invitation',
  'template_key',
  'bounce_kind',
  'has_reason',
  'cta',
  'table',
  'action',
] as const

/**
 * One of `TIMELINE_PROP_KEYS`.
 */
export type TimelinePropertyKey = (typeof TIMELINE_PROP_KEYS)[number]

/**
 * The `code` of the 502 a timeline answers when PostHog could not be asked
 * or did not answer.
 */
export const TIMELINE_UNAVAILABLE_CODE = 'TIMELINE_UNAVAILABLE'
