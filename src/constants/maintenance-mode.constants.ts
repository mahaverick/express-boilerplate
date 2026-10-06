/**
 * @file The fixed values of maintenance mode: its modes, header, timings,
 * text bounds and error codes. Everything new is named `maintenance-mode`;
 * the `maintenance` queue (the retention purge) is unrelated.
 */

/**
 * The modes, mirrored into `maintenance_mode_state_mode_check`.
 */
export const MAINTENANCE_MODES = ['off', 'read_only', 'full'] as const

/**
 * One of `MAINTENANCE_MODES`.
 */
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number]

/**
 * The response header carrying this replica's mode, on every response the
 * gate sees.
 */
export const MAINTENANCE_MODE_HEADER = 'Maintenance-Mode'

/**
 * How often each replica reloads the stored mode whether or not a change
 * message arrived: the backstop for a missed or lost Redis message.
 */
export const MAINTENANCE_MODE_RELOAD_INTERVAL_MS = 10_000

/**
 * The `Retry-After` value, in seconds, on every maintenance 503.
 */
export const MAINTENANCE_MODE_RETRY_AFTER_SECONDS = 30

/**
 * The one shared deadline a change into `full` waits for its notice jobs
 * before pausing the queues.
 */
export const MAINTENANCE_MODE_NOTICE_WAIT_MS = 10_000

/**
 * The longest customer message or internal reason, in characters.
 */
export const MAINTENANCE_MODE_TEXT_MAX_LENGTH = 500

/**
 * The 503 code for a request refused in `full`, and for a non-staff sign-in in `full`.
 */
export const MAINTENANCE_MODE_CODE = 'MAINTENANCE_MODE'

/**
 * The 503 code for a write refused in `read_only`.
 */
export const READ_ONLY_MODE_CODE = 'READ_ONLY_MODE'

/**
 * The 409 code for a change whose `expectedVersion` is not the stored version.
 */
export const MAINTENANCE_MODE_CONFLICT_CODE = 'MAINTENANCE_MODE_CONFLICT'

/**
 * The 400 code for switching on or escalating without `confirm` equal to `APP_ENV`.
 */
export const CONFIRMATION_MISMATCH_CODE = 'CONFIRMATION_MISMATCH'
