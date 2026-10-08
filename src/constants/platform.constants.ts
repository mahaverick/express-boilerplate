/**
 * @file Values shared by the platform validators and services.
 */
import type { OnboardingState } from '@/constants/onboarding.constants'
import { TENANT_LIFECYCLE_STATES, type TenantLifecycleState } from '@/constants/tenant.constants'

/**
 * The windows the staff Overview offers.
 */
export const STATS_RANGES = ['7d', '30d'] as const

/**
 * One of STATS_RANGES.
 */
export type StatsRange = (typeof STATS_RANGES)[number]

/**
 * Which way a keyset page moves from its cursor.
 */
export const PAGE_DIRECTIONS = ['next', 'prev'] as const

/**
 * One of PAGE_DIRECTIONS.
 */
export type PageDirection = (typeof PAGE_DIRECTIONS)[number]

/**
 * The staff tenant list's state filter: one lifecycle state, or `all`.
 * Omitted means active and suspended, the tenants that still exist for
 * their members.
 */
export const TENANT_STATE_FILTERS = [...TENANT_LIFECYCLE_STATES, 'all'] as const

/**
 * One of TENANT_STATE_FILTERS.
 */
export type TenantStateFilter = (typeof TENANT_STATE_FILTERS)[number]

/**
 * The lifecycle states a filter selects.
 * @param filter - The query's `state`, or undefined when omitted.
 * @returns The states to match.
 */
export function statesFor(filter: TenantStateFilter | undefined): TenantLifecycleState[] {
  if (filter === undefined) return ['active', 'suspended']
  if (filter === 'all') return [...TENANT_LIFECYCLE_STATES]
  return [filter]
}

/**
 * The staff suppression list's state filter: suppressions in force, lifted
 * ones, or both.
 */
export const EMAIL_SUPPRESSION_STATE_FILTERS = ['active', 'lifted', 'all'] as const

/**
 * One of EMAIL_SUPPRESSION_STATE_FILTERS.
 */
export type EmailSuppressionStateFilter = (typeof EMAIL_SUPPRESSION_STATE_FILTERS)[number]

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
 * One of ONBOARDING_TENANT_STATE_FILTERS.
 */
export type OnboardingTenantStateFilter = (typeof ONBOARDING_TENANT_STATE_FILTERS)[number]

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
