/**
 * @file Values shared by the platform validators and services.
 */
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
