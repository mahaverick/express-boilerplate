/**
 * @file `pnpm analytics:backfill-groups`: queue a PostHog group marker for
 * every tenant (`backfillTenantGroups`, analytics-backfill.service.ts); the
 * analytics Worker sends them with each tenant's current properties. Run
 * once per environment after setting `POSTHOG_PROJECT_KEY`. Prints counts
 * only, never a tenant name.
 */
import { fileURLToPath } from 'node:url'
import { redactedForLog } from '@/errors/postgres-errors'
import { backfillTenantGroups } from '@/services/analytics/analytics-backfill.service'
import { closeDatabase } from '@/services/database.service'

const USAGE = 'Usage: pnpm analytics:backfill-groups'

/**
 * Backfill every tenant group, printing the outcome.
 * @param argv - The arguments after the script path; only pnpm's `--` is allowed.
 * @returns The process exit code: 0 when every marker was queued, 1 otherwise.
 */
export async function runAnalyticsBackfillGroups(argv: readonly string[]): Promise<number> {
  try {
    if (argv.some((argument) => argument !== '--')) throw new Error(USAGE)
    const result = await backfillTenantGroups()
    process.stdout.write(
      `Queued ${String(result.tenants)} tenant group markers in ${String(result.batches)} batches; the analytics Worker sends them.\n`
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cause = error instanceof Error ? causeText(error.cause) : undefined
    const suffix = cause === undefined ? '' : ': ' + cause
    process.stderr.write(`${message}${suffix}\n`)
    return 1
  }
}

/**
 * The cause of a failure as text: an error's message, with a database query
 * error reduced to its name and driver code, because its own message carries
 * the bound parameters.
 * @param cause - The error's `cause`.
 * @returns The text, or undefined when there is no cause.
 */
function causeText(cause: unknown): string | undefined {
  if (cause === undefined) return undefined
  const safe = redactedForLog(cause)
  if (safe instanceof Error) return safe.message
  if (typeof safe === 'object' && safe !== null) {
    const { name, driverCode } = safe as { name?: unknown; driverCode?: unknown }
    const code = typeof driverCode === 'string' ? ` (driver code ${driverCode})` : ''
    return `${typeof name === 'string' ? name : 'QueryError'}${code}`
  }
  return String(safe)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAnalyticsBackfillGroups(process.argv.slice(2))
  await closeDatabase()
}
