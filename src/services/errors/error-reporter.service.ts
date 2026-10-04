/**
 * @file The server error reporter's entry points. `shouldCaptureHttpError`
 * is the capture rule `errorHandler` applies to a 5xx; the event builder's
 * types and `scrubbedErrorForSpan` are re-exported here, so callers import
 * the reporter alone.
 */
import { HttpError } from '@/errors/http-error'
import { TimelineUnavailableError } from '@/errors/timeline-errors'

export type { ErrorCapturePoint, ErrorContext } from '@/services/errors/error-event.service'
export { scrubbedErrorForSpan } from '@/services/errors/error-event.service'

/**
 * Whether `errorHandler` reports an error it answers with a 5xx. A
 * non-`HttpError` (an unexpected throw) always is. An `HttpError` is a
 * deliberate response, reported only when it wraps a `cause`, the fault
 * behind it. A `TimelineUnavailableError` never is: PostHog is the thing
 * that is down, and its thrower already logged why. Below 500, nothing is.
 * @param error - The error `errorHandler` received.
 * @param status - The status it resolved.
 * @returns True when the error is reported.
 */
export function shouldCaptureHttpError(error: unknown, status: number): boolean {
  if (status < 500 || error instanceof TimelineUnavailableError) return false
  if (error instanceof HttpError) return error.cause !== undefined && error.cause !== null
  return true
}
