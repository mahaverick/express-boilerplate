/**
 * @file `pnpm billing:tax-reconcile [--apply] [--tenant <slug>]`: plans the
 * tax documents every workspace with a tracked subscription is owed (or the
 * one named) and prints one line each. By default it only reads: the
 * provider and the database, nothing written, nothing queued. With
 * `--apply` it queues one `tax-reconcile` job per workspace with work, and
 * the billing worker issues the documents. Use it after turning
 * registration on, for charges and refunds the daily steps haven't reached.
 *
 * Output is counts and slugs only, never a name, address or GSTIN.
 */
import { fileURLToPath } from 'node:url'
import { gstSellerConfig } from '@/configs/billing.config'
import { addTaxReconcileJob } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { planTaxDocuments } from '@/services/billing/tax-reconcile.service'
import { closeDatabase } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { TaxPlan } from '@/types/tax'

const billingRepository = new BillingRepository()
const tenantRepository = new TenantRepository()

/**
 * What one workspace's plan owes, as the counts the script prints.
 */
interface PlanCounts {
  invoices: number
  creditNotes: number
  held: number
  late: number
  overCredited: number
}

/**
 * Count a plan. Only invoices can be counted late: a credit note's
 * lateness is decided when it is issued, so it isn't planned.
 * @param plan - The workspace's plan.
 * @returns Its counts.
 */
function countsOf(plan: TaxPlan): PlanCounts {
  return {
    invoices: plan.invoices.length,
    creditNotes: plan.creditNotes.length,
    held: plan.holds.length,
    late: plan.invoices.filter((invoice) => invoice.isLate).length,
    overCredited: plan.overCredits.length,
  }
}

/**
 * One output line's counts, in the order the lines print them.
 * @param counts - The counts.
 * @returns The text after the label.
 */
function describeCounts(counts: PlanCounts): string {
  return `${String(counts.invoices)} invoices, ${String(counts.creditNotes)} credit notes, ${String(counts.held)} held, ${String(counts.late)} late (over 30 days), ${String(counts.overCredited)} over-credited refunds`
}

/**
 * Whether a workspace has anything for a run to do.
 * @param counts - The workspace's counts.
 * @returns True when a run would issue, hold or alert on something.
 */
function hasWork(counts: PlanCounts): boolean {
  return counts.invoices + counts.creditNotes + counts.held + counts.overCredited > 0
}

/**
 * Read the flags.
 * @param argv - The arguments after the script path.
 * @returns The flags.
 * @throws {Error} On an unknown flag or a `--tenant` with no slug.
 */
function parseArguments(argv: readonly string[]): { shouldApply: boolean; slug: string | null } {
  let shouldApply = false
  let slug: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') {
      shouldApply = true
    } else if (argument === '--tenant') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--tenant needs a workspace slug.')
      }
      slug = value
      index += 1
    } else {
      throw new Error(`Unknown argument ${String(argument)}. Use [--apply] [--tenant <slug>].`)
    }
  }
  return { shouldApply, slug }
}

/**
 * Plan every workspace (or the named one) and print or queue the result.
 * Every workspace is planned before anything is queued, so a planner error
 * for one workspace (a provider read that can still succeed on a retry)
 * stops the whole run with exit 1 and nothing queued; run it again once the
 * provider answers.
 * @param argv - The arguments after the script path.
 * @returns The process exit code: 0 on success, 1 on a refusal or any failure.
 */
export async function runBillingTaxReconcile(argv: readonly string[]): Promise<number> {
  try {
    const { shouldApply, slug } = parseArguments(argv)
    if (gstSellerConfig() === null) {
      throw new Error(
        'GST registration is off. Set BILLING_GST_REGISTERED=true and the seller details first.'
      )
    }
    const provider = getBillingProvider()
    if (provider === null) throw new Error('Payments are off. Set the Razorpay keys first.')

    let targets: Array<{ id: string; slug: string }>
    if (slug === null) {
      const ids = await billingRepository.listTenantIdsWithTrackedSubscriptions({
        kind: provider.kind,
        mode: provider.mode,
      })
      targets = []
      for (const id of ids) {
        const tenant = await tenantRepository.findByIdIncludingDeleted(id)
        if (tenant !== undefined) targets.push({ id, slug: tenant.slug })
      }
    } else {
      const tenant = await tenantRepository.findBySlug(slug)
      if (tenant === undefined) throw new Error(`No workspace has the slug ${slug}.`)
      targets = [{ id: tenant.id, slug: tenant.slug }]
    }

    const total: PlanCounts = { invoices: 0, creditNotes: 0, held: 0, late: 0, overCredited: 0 }
    const withWork: string[] = []
    for (const target of targets) {
      const counts = countsOf(await planTaxDocuments(target.id, {}))
      process.stdout.write(`${target.slug}: ${describeCounts(counts)}\n`)
      for (const key of Object.keys(total) as Array<keyof PlanCounts>) total[key] += counts[key]
      if (hasWork(counts)) withWork.push(target.id)
    }
    process.stdout.write(`Total: ${describeCounts(total)}\n`)

    if (!shouldApply) {
      process.stdout.write(
        'Dry run: nothing was issued. Run with --apply to queue the issue jobs.\n'
      )
      return 0
    }
    for (const tenantId of withWork) await addTaxReconcileJob({ tenantId })
    process.stdout.write(
      `Queued ${String(withWork.length)} workspaces. The billing worker issues their documents.\n`
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBillingTaxReconcile(process.argv.slice(2))
  await closeQueue()
  await closeRedis()
  await closeDatabase()
}
