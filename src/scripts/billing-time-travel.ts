/**
 * @file `pnpm billing:time-travel -- --tenant <slug> --days <n>`: on local
 * only, move one workspace's billing clock back by whole days, so a walk
 * reaches a trial end, a grace end or a period end without waiting. It
 * shifts the row's trial start and end, period end, past-due, halt and
 * pause stamps, the period end a renewal reminder was sent for (so it still
 * names the same period), the workspace's state history (so the win-back
 * days count from the moved move to Free), and every date of the
 * workspace's fake subscriptions so a sync agrees, then queues a sync of the
 * workspace and one frequent billing run. A worker must be running to take
 * them (`pnpm dev` starts one).
 *
 * It refuses a workspace whose row names a provider other than the fake, so
 * it never shifts a real subscription's dates. The other reminder and notice
 * stamps are not shifted: a reminder already sent stays sent.
 * Prints the slug and id only.
 */
import { fileURLToPath } from 'node:url'
import { getEnv, isBillingLocalToolAllowed, type Env } from '@/configs/env.config'
import type { TenantBillingRecord } from '@/database/models/billing.model'
import { addBillingFrequentRunJob, addBillingSyncJob } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { getBillingProvider } from '@/services/billing/billing-provider.service'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { closeDatabase, withTransaction } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'

const billingRepository = new BillingRepository()
const tenantRepository = new TenantRepository()

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The most days one run may move a workspace back: ten years.
 */
const MAX_DAYS = 3650

const USAGE = 'Usage: pnpm billing:time-travel -- --tenant <slug> --days <n>'

/**
 * The refusal for a row on a real provider.
 */
const REAL_PROVIDER_REFUSAL =
  'This workspace pays through a real provider, so its dates stay as they are. Pick a workspace from pnpm billing:seed.'

/**
 * The row columns time travel moves back.
 */
const SHIFTED_COLUMNS = [
  'trialStartedAt',
  'trialEndsAt',
  'currentPeriodEnd',
  'pastDueSince',
  'haltedAt',
  'pausedAt',
  'renewalReminderForPeriodEnd',
] as const satisfies readonly (keyof TenantBillingRecord)[]

/**
 * The script's validated arguments.
 */
interface TimeTravelArguments {
  slug: string
  days: number
}

/**
 * Read `--tenant <slug> --days <n>` from the command line, ignoring pnpm's `--`.
 * @param argv - The arguments after the script path.
 * @returns The slug and a whole number of days from 1 to ten years.
 * @throws {Error} The usage line for a missing, extra or malformed argument.
 */
function parseArguments(argv: readonly string[]): TimeTravelArguments {
  const tokens = argv.filter((argument) => argument !== '--')
  let slug: string | undefined
  let days: number | undefined
  for (let index = 0; index < tokens.length; index += 2) {
    const next = tokens[index + 1]
    const value = next?.startsWith('--') === true ? undefined : next
    if (tokens[index] === '--tenant' && slug === undefined && value !== undefined) {
      slug = value
    } else if (tokens[index] === '--days' && days === undefined && value !== undefined) {
      days = /^\d+$/.test(value) ? Number(value) : Number.NaN
    } else {
      throw new Error(USAGE)
    }
  }
  if (slug === undefined || days === undefined) throw new Error(USAGE)
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`Days must be a whole number from 1 to ${String(MAX_DAYS)}. ${USAGE}`)
  }
  return { slug, days }
}

/**
 * The fake provider, when the row holds fake subscriptions.
 * @param row - The workspace's billing row.
 * @returns The fake, or null when the row holds no subscription.
 * @throws {Error} When the row holds one and the fake provider is off.
 */
function fakeFor(row: TenantBillingRecord): FakeBillingProvider | null {
  const held = [row.providerSubscriptionId, row.pendingSubscriptionId, row.nextSubscriptionId]
  if (held.every((id) => id === null)) return null
  const provider = getBillingProvider()
  if (!(provider instanceof FakeBillingProvider)) {
    throw new Error(
      'This workspace has fake subscriptions, but the fake provider is off. Set BILLING_FAKE_PROVIDER=true in .env and run it again.'
    )
  }
  return provider
}

/**
 * Move the dates of a workspace's fake subscriptions.
 * @param fake - The fake provider.
 * @param subscriptionIds - The subscriptions the row holds.
 * @param ms - How far back, in milliseconds; negative moves them forward again.
 * @throws {Error} When Redis cannot be reached or written.
 */
async function shiftFake(
  fake: FakeBillingProvider,
  subscriptionIds: readonly string[],
  ms: number
): Promise<void> {
  const moved: string[] = []
  try {
    for (const id of subscriptionIds) {
      await fake.fakeShiftBack(id, ms)
      moved.push(id)
    }
  } catch (error) {
    // Put back the ones that moved, so the fake and the row still agree.
    for (const id of moved) {
      try {
        await fake.fakeShiftBack(id, -ms)
      } catch {
        // Redis is already failing; the refusal below asks for a rerun either way.
      }
    }
    throw new Error(
      'Redis did not take the new fake subscription dates, so the billing record stayed as it was. Check that Redis is running, then run it again.',
      { cause: error }
    )
  }
}

/**
 * Move the row's dates, and its workspace's history, back under its lock,
 * when it still holds the same provider and subscriptions it was read with.
 * @param tenantId - The workspace.
 * @param read - The row as read before the fake moved.
 * @param ms - How far back, in milliseconds.
 * @returns The row after the move, or undefined when it changed or is gone.
 * @throws {Error} The real-provider refusal when the row now names one.
 */
async function shiftRow(
  tenantId: string,
  read: TenantBillingRecord,
  ms: number
): Promise<TenantBillingRecord | undefined> {
  return withTransaction(async (tx) => {
    const locked = await billingRepository.lockByTenantId(tenantId, tx)
    if (locked === undefined) return
    if (locked.provider !== null && locked.provider !== 'fake') {
      throw new Error(REAL_PROVIDER_REFUSAL)
    }
    const isSameSubscriptions =
      locked.providerSubscriptionId === read.providerSubscriptionId &&
      locked.pendingSubscriptionId === read.pendingSubscriptionId &&
      locked.nextSubscriptionId === read.nextSubscriptionId
    if (!isSameSubscriptions) return
    const patch: Partial<Record<(typeof SHIFTED_COLUMNS)[number], Date | null>> = {}
    for (const column of SHIFTED_COLUMNS) {
      const value = locked[column]
      patch[column] = value === null ? null : new Date(value.getTime() - ms)
    }
    const shifted = await billingRepository.updateVersioned(tenantId, locked.version, patch, tx)
    if (shifted !== undefined) await billingRepository.shiftHistoryBack(tenantId, ms, tx)
    return shifted
  })
}

/**
 * Move one workspace's billing dates back, then queue a sync and a run.
 * @param argv - The arguments after the script path.
 * @param env - The environment slice; defaults to the validated environment.
 * @returns The process exit code: 0 on success, 1 on a refusal or any failure.
 */
export async function runBillingTimeTravel(
  argv: readonly string[],
  env: Pick<Env, 'APP_ENV'> = getEnv()
): Promise<number> {
  try {
    if (!isBillingLocalToolAllowed(env)) {
      throw new Error('Time travel runs on APP_ENV=local only. Run it on your own machine.')
    }
    const { slug, days } = parseArguments(argv)
    const tenant = await tenantRepository.findBySlug(slug)
    if (tenant === undefined) {
      throw new Error(`No workspace has the slug ${slug}. Check the slug and run it again.`)
    }
    const row = await billingRepository.findByTenantId(tenant.id)
    if (row === undefined) {
      throw new Error(`Workspace ${tenant.id} has no billing record. Pick a customer workspace.`)
    }
    if (row.provider !== null && row.provider !== 'fake') throw new Error(REAL_PROVIDER_REFUSAL)
    const fake = fakeFor(row)
    const ms = days * DAY_MS
    const subscriptionIds = [
      row.providerSubscriptionId,
      row.pendingSubscriptionId,
      row.nextSubscriptionId,
    ].filter((id): id is string => id !== null)
    // The fake moves first: a Redis failure stops the run before the row changes.
    if (fake !== null) await shiftFake(fake, subscriptionIds, ms)
    let shifted: TenantBillingRecord | undefined
    try {
      shifted = await shiftRow(tenant.id, row, ms)
    } catch (error) {
      if (fake !== null) await shiftFake(fake, subscriptionIds, -ms)
      throw error
    }
    if (shifted === undefined) {
      if (fake !== null) await shiftFake(fake, subscriptionIds, -ms)
      throw new Error('The billing record changed while it was being moved. Run it again.')
    }
    await addBillingSyncJob({ tenantId: tenant.id, source: 'job' })
    await addBillingFrequentRunJob()
    process.stdout.write(
      `Moved ${slug} (${tenant.id}) back ${String(days)} days. Queued a sync and a billing run.\n`
    )
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBillingTimeTravel(process.argv.slice(2))
  await closeQueue()
  await closeRedis()
  await closeDatabase()
}
