/**
 * @file BullMQ job priorities, named so call sites never pass a bare number.
 */

/**
 * BullMQ job priority levels. BullMQ processes a lower value first, so
 * `critical` (1) runs ahead of `low` (10).
 */
export const JobPriority = {
  critical: 1,
  high: 2,
  normal: 5,
  low: 10,
} as const
