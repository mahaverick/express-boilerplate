/**
 * @file The error a call to PostHog's private API answers when PostHog could
 * not be asked or did not answer usably. The thrower has already logged why, at
 * the level the cause calls for, so `errorHandler` (error.middleware.ts) does
 * not log it again.
 */
import { HttpError } from '@/errors/http-error'

/**
 * The `code` a PostHog 502 carries.
 */
const POSTHOG_UNAVAILABLE_CODE = 'POSTHOG_UNAVAILABLE'

/**
 * A 502: a call to PostHog's private API failed, timed out or answered with an error. Its thrower logs why.
 */
export class PosthogUnavailableError extends HttpError {
  /**
   * The message is fixed; `errorHandler` masks it as for every 5xx.
   */
  constructor() {
    super('PostHog is unavailable', 502, POSTHOG_UNAVAILABLE_CODE)
    this.name = 'PosthogUnavailableError'
  }
}
