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
