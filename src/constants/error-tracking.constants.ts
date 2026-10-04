/**
 * @file Fixed limits of the server error reporter
 * (services/errors/error-reporter.service.ts): how often it flushes, how
 * much it buffers and sends, how it backs off, how much of an error it
 * keeps, and how long its Redis counters live.
 */

/**
 * Milliseconds between flushes of a non-empty queue.
 */
export const ERROR_FLUSH_INTERVAL_MS = 5000

/**
 * Queued events that start a flush at once, and the most one batch sends.
 */
export const ERROR_FLUSH_BATCH = 50

/**
 * The most events the queue holds; one more drops the oldest as `buffer_full`.
 */
export const ERROR_QUEUE_MAX = 500

/**
 * Events with one fingerprint a process sends in any rolling minute.
 */
export const ERROR_FINGERPRINT_PER_MINUTE = 10

/**
 * Events a process sends in any rolling minute, whatever their fingerprint.
 */
export const ERROR_GLOBAL_PER_MINUTE = 100

/**
 * The back-off after the first send PostHog asked to retry; it doubles with
 * each consecutive one.
 */
export const ERROR_RETRY_BASE_MS = 5000

/**
 * The longest back-off between sends.
 */
export const ERROR_RETRY_MAX_MS = 300_000

/**
 * Sends of one batch PostHog may ask to retry before the batch is dropped
 * as `retry_exhausted`.
 */
export const ERROR_RETRY_LIMIT = 5

/**
 * The most characters a scrubbed text keeps, its truncation marker included.
 */
export const ERROR_VALUE_MAX = 1024

/**
 * The most exceptions one event lists: the error and its `cause` chain.
 */
export const ERROR_CAUSE_DEPTH = 5

/**
 * The most stack frames one exception keeps, the innermost ones.
 */
export const ERROR_FRAME_LIMIT = 50

/**
 * How long a process fault waits for queued reports to send before exiting.
 */
export const ERROR_FATAL_FLUSH_MS = 2000

/**
 * How long a graceful shutdown waits for queued reports to send.
 */
export const ERROR_SHUTDOWN_FLUSH_MS = 3000

/**
 * Seconds a per-minute outcome counter lives in Redis: longer than the
 * status window, so every bucket the window reads still exists.
 */
export const ERROR_COUNTER_TTL_SECONDS = 1200

/**
 * Minutes of counters the status endpoint sums.
 */
export const ERROR_STATUS_WINDOW_MINUTES = 15

/**
 * Why a report was not delivered: over the throttle, pushed out of a full
 * queue, refused by PostHog, or still failing after `ERROR_RETRY_LIMIT` sends.
 */
export const ERROR_DROP_REASONS = [
  'throttled',
  'buffer_full',
  'rejected',
  'retry_exhausted',
] as const

/**
 * One of `ERROR_DROP_REASONS`.
 */
export type ErrorDropReason = (typeof ERROR_DROP_REASONS)[number]
