// tests/unit/constants/global.constants.test.ts
import { describe, expect, it } from 'vitest'
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from '@/constants/global.constants'

describe('GRACEFUL_SHUTDOWN_TIMEOUT_MS', () => {
  it('is positive and comfortably inside a 30s Kubernetes termination grace period', () => {
    // A guard, not just coverage: if someone "tidies" this toward Kubernetes'
    // own default terminationGracePeriodSeconds (30s), the orchestrator's
    // SIGKILL — not this backstop — becomes the thing that ends the process,
    // which is exactly what the backstop exists to prevent.
    expect(GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GRACEFUL_SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000)
  })
})
