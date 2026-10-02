/**
 * @file `pnpm onboarding:reconcile`: re-complete the default automatic
 * onboarding steps of every tracked, started tenant from what members
 * provably did (`reconcileOnboarding`, platform-onboarding.service.ts),
 * each dated when it happened, for when a subscriber failed after its
 * request committed. Staff actions through platform access never count.
 * Best effort: it reads the audit log, so an entry pruned under
 * `RETENTION_AUDIT_LOGS_DAYS` leaves no trace. Prints counts only, never a
 * tenant or an address.
 */
import { fileURLToPath } from 'node:url'
import { closeDatabase } from '@/services/database.service'
import { reconcileOnboarding } from '@/services/platform-onboarding.service'

const USAGE = 'Usage: pnpm onboarding:reconcile'

/**
 * Reconcile every tracked tenant, printing the outcome.
 * @param argv - The arguments after the script path; only pnpm's `--` is allowed.
 * @returns The process exit code: 0 when every step that should be done is, 1 otherwise.
 */
export async function runOnboardingReconcile(argv: readonly string[]): Promise<number> {
  try {
    if (argv.some((argument) => argument !== '--')) throw new Error(USAGE)
    const result = await reconcileOnboarding()
    process.stdout.write(
      `Checked ${result.tenantsChecked} tenants; restored ${result.stepsRestored} steps.\n`
    )
    if (result.failures === 0) return 0
    process.stderr.write(`${result.failures} steps could not be restored; see the log.\n`)
    return 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOnboardingReconcile(process.argv.slice(2))
  await closeDatabase()
}
