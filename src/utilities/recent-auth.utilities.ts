/**
 * @file The recent-sign-in predicate behind step-up, shared by the
 * `requireRecentAuth` middleware and the services that decide step-up per
 * request (a resend of a platform-tenant invitation), which may not import
 * a middleware.
 */
import { STEP_UP_MAX_AGE_MS } from '@/constants/auth.constants'
import { MS_PER_SECOND } from '@/utilities/duration.utilities'

/**
 * Whether the session behind an access token authenticated within
 * `maxAgeMs` of `now`. A token with no `auth_time` claim (its session
 * predates migration 0018) counts as stale.
 * @param authTime - The token's `auth_time`, in seconds since the epoch, as `requireAuth` copies it to `request.authTime`.
 * @param now - The current time, in milliseconds since the epoch.
 * @param maxAgeMs - The oldest authentication accepted. Defaults to STEP_UP_MAX_AGE_MS.
 * @returns True when the sign-in is recent enough.
 */
export function isRecentAuth(
  authTime: number | undefined,
  now: number,
  maxAgeMs: number = STEP_UP_MAX_AGE_MS
): boolean {
  return authTime !== undefined && now - authTime * MS_PER_SECOND <= maxAgeMs
}
