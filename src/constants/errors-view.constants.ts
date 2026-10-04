/**
 * @file Fixed values of the staff Errors views: how far back they look, how
 * many issues they list, and the event property PostHog writes each
 * `$exception`'s issue id to at ingestion.
 */

/**
 * The window an Errors view covers, newest event back.
 */
export const ERRORS_VIEW_DAYS = 30

/**
 * The most issues one Errors view lists, newest last-seen first.
 */
export const ERRORS_VIEW_LIMIT = 50

/**
 * The property PostHog's error tracking sets on an ingested `$exception`:
 * the issue it grouped the event into. It is absent for a few seconds after
 * ingestion, and on an event PostHog could not group.
 */
export const ERROR_ISSUE_ID_PROPERTY = '$exception_issue_id'
