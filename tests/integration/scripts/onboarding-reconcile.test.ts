/**
 * @file Exercises `runOnboardingReconcile` against the real per-worker
 * Postgres: the exit code and what it prints. What it restores is covered
 * in `tests/integration/services/onboarding-reconcile.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOnboardingReconcile } from '@/scripts/onboarding-reconcile'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runOnboardingReconcile', () => {
  it('prints the counts and exits 0, ignoring pnpm’s --', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runOnboardingReconcile(['--'])

    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(
      expect.stringMatching(/^Checked \d+ tenants; restored \d+ steps\.\n$/)
    )
  })

  it('exits 1 with the usage line for any argument', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await runOnboardingReconcile(['--', 'extra'])

    expect(code).toBe(1)
    expect(stderr).toHaveBeenCalledWith('Usage: pnpm onboarding:reconcile\n')
  })
})
