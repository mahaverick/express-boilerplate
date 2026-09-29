/**
 * @file Values shared by the platform validators and services.
 */

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
