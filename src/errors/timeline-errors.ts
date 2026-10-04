/**
 * @file The error a timeline answers when PostHog could not be asked or did
 * not answer usably. The thrower has already logged why, at the level the
 * cause calls for, so `errorHandler` (error.middleware.ts) does not log it again.
 */
import { TIMELINE_UNAVAILABLE_CODE } from '@/constants/timeline.constants'
import { HttpError } from '@/errors/http-error'

/**
 * A 502 with `code: 'TIMELINE_UNAVAILABLE'`: the PostHog query failed, timed
 * out, was refused, answered in an unexpected shape, or was not sent because
 * the hourly budget is spent.
 */
export class TimelineUnavailableError extends HttpError {
  /**
   * The message is fixed; `errorHandler` masks it as for every 5xx.
   */
  constructor() {
    super('PostHog is unavailable', 502, TIMELINE_UNAVAILABLE_CODE)
    this.name = 'TimelineUnavailableError'
  }
}
