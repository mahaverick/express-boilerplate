/**
 * @file The shapes of the staff Errors views: one error issue as the API
 * returns it, and the response. Built only by errors-mapper.service.ts.
 */

/**
 * Where an issue's most recent event came from: `server` when it claims
 * `app: 'api'`, `browser` otherwise. Whether that claim is the server's own
 * is `verified`.
 */
export type ErrorIssueSource = 'server' | 'browser'

/**
 * One PostHog error issue a user or tenant hit in the window, described by
 * its most recent event.
 */
export interface ErrorIssue {
  issueId: string
  /**
   * The exception type, re-scrubbed.
   */
  type: string
  /**
   * The exception message, re-scrubbed. Untrusted text: render it as text.
   */
  value: string
  /**
   * Events in the window grouped into this issue.
   */
  count: number
  firstSeen: string
  lastSeen: string
  source: ErrorIssueSource
  /**
   * `api`, `react` or `apex`; null for anything else.
   */
  app: string | null
  /**
   * Whether the most recent event's `server_sig` verifies.
   */
  verified: boolean
  /**
   * The issue's page in PostHog Error Tracking.
   */
  link: string
}

/**
 * An Errors view: `configured: false` without the PostHog personal key and
 * project id, otherwise the issues (never paged, so `nextCursor` is null).
 */
export type ErrorIssuesPage =
  { configured: false } | { configured: true; items: ErrorIssue[]; nextCursor: null }
