/**
 * @file Exercises `runBillingTaxReconcile` against this worker's database and
 * the fake provider in Redis: it refuses when registration or payments are
 * off, a dry run prints one line per workspace and writes nothing, `--apply`
 * queues one `tax-reconcile` job per workspace with work, and an unknown
 * slug is refused.
 */
import type { Job } from 'bullmq'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test'
import { BILLING_TAX_RECONCILE_JOB, type BillingTaxReconcileJobData } from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { runBillingTaxReconcile } from '@/scripts/billing-tax-reconcile'
import { sql } from '@/services/database.service'
import { closeQueue, getBillingQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  workspace,
} from '../../helpers/billing-api'
import { deleteTrackedUsers } from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import { resetTaxDocuments } from '../../helpers/tax'

/**
 * Whether GST registration is on; a test turns it off and the hooks reset it.
 */
const gst = vi.hoisted(() => ({ on: true }))

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => (gst.on ? seller : null),
  }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const billingRepository = new BillingRepository()

let out = ''
let errorOutput = ''

beforeAll(loadPlans)

beforeEach(async () => {
  await resetTaxDocuments()
  out = ''
  errorOutput = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errorOutput += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  gst.on = true
  paymentsSwitch.on = true
  await resetTaxDocuments()
  await getBillingQueue().obliterate({ force: true })
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await getBillingQueue().obliterate({ force: true })
  await closeQueue()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * Two workspaces that each paid once, an hour ago, with nothing invoiced yet.
 * @returns Their ids and slugs.
 */
async function twoPayingWorkspaces(): Promise<Array<{ id: string; slug: string }>> {
  const made: Array<{ id: string; slug: string }> = []
  for (let n = 0; n < 2; n += 1) {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const charges = await fake.listPaidCharges(subscriptionId)
    const latest = charges.at(-1)
    if (latest === undefined) throw new Error('setup: the subscription has no charge')
    await fake.fakeShiftBack(subscriptionId, latest.paidAt.getTime() - (Date.now() - 3_600_000))
    // The script walks tracked subscriptions, which a held one has no row for.
    await billingRepository.recordTrackedSubscription(
      tenant.id,
      { kind: 'fake', mode: 'test' },
      subscriptionId,
      'late_switch'
    )
    made.push({ id: tenant.id, slug: tenant.slug })
  }
  return made
}

/**
 * The count of tax documents in this worker's database.
 * @returns The count.
 */
async function documentCount(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from tax_documents`
  return row?.n ?? 0
}

/**
 * The `tax-reconcile` jobs on the billing queue.
 * @returns The jobs.
 */
async function taxJobs(): Promise<Job<BillingTaxReconcileJobData>[]> {
  const jobs = await queuedJobs<BillingTaxReconcileJobData>(getBillingQueue())
  return jobs.filter((job) => job.name === BILLING_TAX_RECONCILE_JOB)
}

describe('billing:tax-reconcile', () => {
  it('refuses when GST registration is off', async () => {
    gst.on = false
    expect(await runBillingTaxReconcile([])).toBe(1)
    expect(errorOutput).toBe(
      'GST registration is off. Set BILLING_GST_REGISTERED=true and the seller details first.\n'
    )
  })

  it('refuses when payments are off', async () => {
    paymentsSwitch.on = false
    expect(await runBillingTaxReconcile([])).toBe(1)
    expect(errorOutput).toBe('Payments are off. Set the Razorpay keys first.\n')
  })

  it('prints one line per workspace on a dry run and writes nothing', async () => {
    const made = await twoPayingWorkspaces()
    expect(await runBillingTaxReconcile([])).toBe(0)
    for (const { slug } of made) {
      expect(out).toContain(
        `${slug}: 1 invoices, 0 credit notes, 0 held, 0 late (over 30 days), 0 over-credited refunds\n`
      )
    }
    expect(out).toContain(
      'Total: 2 invoices, 0 credit notes, 0 held, 0 late (over 30 days), 0 over-credited refunds\n'
    )
    expect(
      out.endsWith('Dry run: nothing was issued. Run with --apply to queue the issue jobs.\n')
    ).toBe(true)
    expect(await documentCount()).toBe(0)
    expect(await taxJobs()).toHaveLength(0)
  })

  it('limits a dry run to the named workspace', async () => {
    const made = await twoPayingWorkspaces()
    expect(await runBillingTaxReconcile(['--tenant', made[0]!.slug])).toBe(0)
    expect(out).toContain(`${made[0]!.slug}: 1 invoices`)
    expect(out).not.toContain(made[1]!.slug)
  })

  it('queues one job per workspace with work on --apply', async () => {
    const made = await twoPayingWorkspaces()
    expect(await runBillingTaxReconcile(['--apply'])).toBe(0)
    const jobs = await taxJobs()
    expect(jobs.map((job) => job.data.tenantId).toSorted()).toEqual(
      made.map((m) => m.id).toSorted()
    )
    expect(out).toContain('Queued 2 workspaces. The billing worker issues their documents.\n')
    expect(await documentCount()).toBe(0)
  })

  it('refuses a slug no workspace has', async () => {
    expect(await runBillingTaxReconcile(['--tenant', 'unknown'])).toBe(1)
    expect(errorOutput).toBe('No workspace has the slug unknown.\n')
  })
})
