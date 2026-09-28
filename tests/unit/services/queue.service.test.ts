/**
 * @file Pure-logic coverage only — anything that touches Redis or BullMQ
 * lives under tests/integration/services/.
 */
import { describe, expect, it } from 'vitest'
import { JobPriority } from '@/constants/queue.constants'

describe('JobPriority', () => {
  it('orders critical < high < normal < low', () => {
    expect(JobPriority.critical).toBeLessThan(JobPriority.high)
    expect(JobPriority.high).toBeLessThan(JobPriority.normal)
    expect(JobPriority.normal).toBeLessThan(JobPriority.low)
  })
})
