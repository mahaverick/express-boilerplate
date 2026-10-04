/**
 * @file Fixed values of the staff timelines: the ranges and views the routes
 * accept, the page size, the cache and PostHog timeouts, the events the
 * queries leave out and the event properties a timeline row may carry.
 */

/**
 * How long one call to PostHog's private API may take. A 90-day timeline
 * query took 2.6–5.6 s on a fresh project.
 */
export const TIMELINE_POSTHOG_TIMEOUT_MS = 15_000
