/**
 * @file Values shared by the platform validators and services.
 */
import type { OnboardingState } from '@/constants/onboarding.constants'

/**
 * The windows the staff Overview offers.
 */
export const STATS_RANGES = ['7d', '30d'] as const

/**
 * One of STATS_RANGES.
 */
export type StatsRange = (typeof STATS_RANGES)[number]

/**
 * The staff onboarding list's state filter: every state a tracked tenant
 * can be in. `not_tracked` is left out, since the list covers tracked
 * tenants only.
 */
export const ONBOARDING_TENANT_STATE_FILTERS = [
  'stuck',
  'in_progress',
  'awaiting_owner',
  'complete',
  'dismissed',
] as const satisfies readonly OnboardingState[]

/**
 * The longest each section of the staff system status waits for a read from
 * Redis before it answers with what it reports when Redis fails. node-redis
 * drops its own command timeout once a command is written, so a stalled
 * server would otherwise hold the whole status request open.
 */
export const STATUS_READ_TIMEOUT_MS = 2000

/**
 * The longest a Redis call on the request path waits for an answer before it
 * is treated as failed (`withRedisDeadline`, redis-deadline.service.ts).
 * node-redis stops timing a command once it is written, so a connected but
 * stalled server would otherwise hold every request that touches it.
 */
export const REDIS_REQUEST_DEADLINE_MS = 300

/**
 * How long request-path Redis calls fail at once, without trying Redis,
 * after one of them missed `REDIS_REQUEST_DEADLINE_MS`: a stalled server
 * then costs each request nothing instead of the whole deadline.
 */
export const REDIS_STALL_COOLDOWN_MS = 5000

/**
 * The longest `GET /health/ready` waits for each dependency check before it
 * reports that check as timed out. Under a typical orchestrator probe
 * timeout (1 s in Kubernetes), so the probe answers 503 itself rather than
 * being cut off; the Redis check's own `REDIS_REQUEST_DEADLINE_MS` is shorter.
 */
export const READINESS_CHECK_DEADLINE_MS = 500
