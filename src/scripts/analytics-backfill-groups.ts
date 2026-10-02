/**
 * @file `pnpm analytics:backfill-groups`: send every tenant's PostHog group
 * properties (`backfillTenantGroups`, analytics-backfill.service.ts). Run
 * once per environment after setting `POSTHOG_PROJECT_KEY`. Prints counts
 * only, never a tenant name.
 */
import { fileURLToPath } from 'node:url'
import { backfillTenantGroups } from '@/services/analytics/analytics-backfill.service'
import { closeDatabase } from '@/services/database.service'

const USAGE = 'Usage: pnpm analytics:backfill-groups'

/**
 * Backfill every tenant group, printing the outcome.
 * @param argv - The arguments after the script path; only pnpm's `--` is allowed.
 * @returns The process exit code: 0 when PostHog acknowledged every batch, 1 otherwise.
 */
export async function runAnalyticsBackfillGroups(argv: readonly string[]): Promise<number> {
  try {
    if (argv.some((argument) => argument !== '--')) throw new Error(USAGE)
    const result = await backfillTenantGroups()
    process.stdout.write(
      `Sent ${String(result.tenants)} tenant groups in ${String(result.batches)} batches.\n`
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAnalyticsBackfillGroups(process.argv.slice(2))
  await closeDatabase()
}
