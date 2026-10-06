/**
 * @file The refusal maintenance mode answers: the gate's for a route the
 * mode closes, and the auth service's for a non-staff sign-in in `full`.
 * `errorHandler` (error.middleware.ts) writes it with its own body and
 * `Retry-After`, and neither masks nor logs it: it is not a fault.
 */
import {
  MAINTENANCE_MODE_RETRY_AFTER_SECONDS,
  type MAINTENANCE_MODE_CODE,
  type READ_ONLY_MODE_CODE,
} from '@/constants/maintenance-mode.constants'
import { HttpError } from '@/errors/http-error'
import type { MaintenanceModeSnapshot } from '@/types/maintenance-mode'

/**
 * The message a refusal carries when the stored one is missing, which the
 * table's CHECK allows only while `off`.
 */
const FALLBACK_MESSAGE = 'The service is down for maintenance. Please try again shortly.'

/**
 * A 503 with `code` `MAINTENANCE_MODE` or `READ_ONLY_MODE`, the owner's
 * customer message, the mode and when it began.
 */
export class MaintenanceModeError extends HttpError {
  /**
   * The mode the refusal was made under.
   */
  readonly mode: MaintenanceModeSnapshot['mode']
  /**
   * When that mode began, or null.
   */
  readonly since: string | null
  /**
   * The `Retry-After` value, in seconds.
   */
  readonly retryAfterSeconds = MAINTENANCE_MODE_RETRY_AFTER_SECONDS

  /**
   * @param code - `MAINTENANCE_MODE` or `READ_ONLY_MODE`.
   * @param snapshot - The replica's mode when it refused.
   */
  constructor(
    code: typeof MAINTENANCE_MODE_CODE | typeof READ_ONLY_MODE_CODE,
    snapshot: Pick<MaintenanceModeSnapshot, 'mode' | 'message' | 'since'>
  ) {
    super(snapshot.message ?? FALLBACK_MESSAGE, 503, code)
    this.name = 'MaintenanceModeError'
    this.mode = snapshot.mode
    this.since = snapshot.since
  }
}
