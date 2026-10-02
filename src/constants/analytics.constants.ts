/**
 * @file Fixed values of the analytics pipeline: the session-id shape the API
 * accepts from a browser.
 */

/**
 * A posthog-js session id: a UUID (posthog-js mints UUIDv7). An
 * `X-POSTHOG-SESSION-ID` header of any other shape is dropped.
 */
export const POSTHOG_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
