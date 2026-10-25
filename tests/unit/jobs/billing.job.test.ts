/**
 * @file The billing queue's retry schedule: waits that double from 30 s up
 * to an hour, and enough attempts that a provider outage of 24 hours,
 * Razorpay's own webhook retry window, does not fail a job for good.
 */
import { describe, expect, it } from 'vite-plus/test'
import {
  BILLING_JOB_ATTEMPTS,
  BILLING_OTHER_FAILURE_ATTEMPTS,
  BILLING_RETRY_MAX_DELAY_MS,
  billingRetryDelay,
} from '@/jobs/billing.job'

/**
 * The total wait before the last of a number of attempts.
 * @param attempts - The attempts.
 * @returns The sum of the waits between them, in milliseconds.
 */
function totalWait(attempts: number): number {
  let total = 0
  for (let made = 1; made < attempts; made += 1) total += billingRetryDelay(made)
  return total
}

const DAY_MS = 24 * 3600 * 1000

describe('billingRetryDelay', () => {
  it('doubles from 30 seconds after each failed attempt', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((made) => billingRetryDelay(made))).toStrictEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000,
    ])
  })

  it('never waits more than an hour', () => {
    expect(billingRetryDelay(8)).toBe(BILLING_RETRY_MAX_DELAY_MS)
    expect(billingRetryDelay(BILLING_JOB_ATTEMPTS)).toBe(BILLING_RETRY_MAX_DELAY_MS)
    expect(BILLING_RETRY_MAX_DELAY_MS).toBe(3_600_000)
  })
})

describe('billing job attempts', () => {
  it('keeps retrying a provider outage for at least 24 hours', () => {
    expect(totalWait(BILLING_JOB_ATTEMPTS)).toBeGreaterThanOrEqual(DAY_MS)
  })

  it('uses no more attempts than 24 hours need', () => {
    expect(totalWait(BILLING_JOB_ATTEMPTS - 1)).toBeLessThan(DAY_MS)
  })

  it('stops any other failure after about an hour', () => {
    // 30 s × (2^7 − 1) = 3810 s: the budget every billing job had before the outage window.
    expect(totalWait(BILLING_OTHER_FAILURE_ATTEMPTS)).toBe(3_810_000)
  })
})
