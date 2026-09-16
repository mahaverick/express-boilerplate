// src/constants/queue.constants.ts
//
// BullMQ priority values — lower number processes first. Named here rather
// than as magic numbers scattered across every `addJob()` call site, same
// reasoning as global.constants.ts's own header.

/**
 * BullMQ job priority levels. Lower numeric value is processed first —
 * BullMQ's own convention, not this file's invention — so `critical` (1)
 * jumps the queue ahead of `low` (10).
 */
export const JobPriority = {
  critical: 1,
  high: 2,
  normal: 5,
  low: 10,
} as const

/**
 * The set of valid `JobPriority` keys, e.g. `'critical' | 'high' | 'normal' | 'low'`.
 */
export type JobPriorityName = keyof typeof JobPriority
