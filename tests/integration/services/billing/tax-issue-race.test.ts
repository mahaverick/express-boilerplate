/**
 * @file Issuing tax documents under concurrency: each payment gets one
 * invoice, numbers are used once with no gap, parallel credit notes never
 * credit more than the invoice, an issue and an invite on one workspace
 * queue on its billing row without a deadlock, and a failed insert gives
 * its number back.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { NewTaxDocument } from '@/database/models/tax.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { BillingRepository } from '@/repositories/billing.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { issueCreditNote, issueInvoice } from '@/services/billing/tax-documents.service'
import { db, sql, withTransaction, type DbTransaction } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { invite } from '@/services/tenant-invitation.service'
import type { ProviderCharge } from '@/types/billing'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { backendPid, deferred, waitForWaiter } from '../../../helpers/lock-probe'
import { withMutatedMethod } from '../../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'
import { resetTaxDocuments } from '../../../helpers/tax'

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => seller,
  }
})

const billingRepository = new BillingRepository()
const taxRepository = new TaxRepository()
const tenantRepository = new TenantRepository()
const scope = { kind: 'razorpay', mode: 'test' } as const
const ISSUED_AT = new Date('2026-10-27T06:30:00.000Z')

const tenantIds: string[] = []

beforeEach(resetTaxDocuments)

afterEach(async () => {
  await resetTaxDocuments()
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A Free workspace with its billing row and owner.
 */
async function workspace(): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Race Co',
    slug: `tax-race-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * A paid charge with fresh ids.
 */
function charge(amountMinor = 99_900): ProviderCharge & { description: string } {
  return {
    invoiceId: `inv_${randomUUID().slice(0, 12)}`,
    subscriptionId: `sub_${randomUUID().slice(0, 12)}`,
    paymentId: `pay_${randomBytes(6).toString('hex')}`,
    amountMinor,
    paidAt: new Date('2026-10-26T05:00:00.000Z'),
    billingStart: null,
    billingEnd: null,
    description: 'Paid, Monthly',
  }
}

/**
 * The last number of the invoice series for 26-27, or undefined when it has none.
 */
async function invoiceCounter(): Promise<number | undefined> {
  const rows = await sql<{ last_number: number }[]>`
    select last_number from tax_document_counters
    where type = 'invoice' and financial_year = '26-27'
  `
  return rows[0]?.last_number
}

/**
 * Hold a workspace's billing row in an open transaction until released.
 * @returns The holder's backend pid, its release and the transaction's promise.
 */
async function holdBillingRow(
  tenantId: string
): Promise<{ pid: number; release: () => void; done: Promise<void> }> {
  const release = deferred()
  const holding = deferred<number>()
  const done = db.transaction(async (tx) => {
    await billingRepository.lockByTenantId(tenantId, tx)
    holding.resolve(await backendPid(tx))
    await release.promise
  })
  return { pid: await holding.promise, release: () => release.resolve(), done }
}

describe('issuing under concurrency', () => {
  it('invoices one payment once when two issues race', async () => {
    const { tenant } = await workspace()
    const paid = charge()

    const results = await Promise.all([
      issueInvoice(tenant.id, paid, scope, ISSUED_AT),
      issueInvoice(tenant.id, paid, scope, ISSUED_AT),
    ])

    expect(results.map((result) => result.outcome).toSorted()).toStrictEqual(['exists', 'issued'])
    expect(await invoiceCounter()).toBe(1)
  })

  it('numbers 10 parallel invoices across 3 workspaces 1 to 10, each once', async () => {
    const tenants = await Promise.all([workspace(), workspace(), workspace()])

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        issueInvoice(tenants[index % 3]!.tenant.id, charge(), scope, ISSUED_AT)
      )
    )

    const numbers = results.map((result) => {
      if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
      return result.document.number
    })
    expect(numbers.toSorted()).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => `INV/26-27/${String(index + 1).padStart(5, '0')}`)
    )
    expect(await invoiceCounter()).toBe(10)
  })

  it('issues one of two parallel credit notes that together exceed the invoice', async () => {
    const { tenant } = await workspace()
    const invoice = await issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
    if (invoice.outcome !== 'issued') throw new Error('not issued')

    const results = await Promise.all([
      issueCreditNote(
        tenant.id,
        invoice.document.id,
        { amountMinor: 60_000, refundId: 'rfnd_R1', reason: 'Refund' },
        ISSUED_AT
      ),
      issueCreditNote(
        tenant.id,
        invoice.document.id,
        { amountMinor: 60_000, refundId: 'rfnd_R2', reason: 'Refund' },
        ISSUED_AT
      ),
    ])

    expect(results.map((result) => result.outcome).toSorted()).toStrictEqual([
      'issued',
      'over_credit',
    ])
    expect(results.find((result) => result.outcome === 'over_credit')).toStrictEqual({
      outcome: 'over_credit',
      remainingMinor: 39_900,
    })
    expect(
      await withTransaction((tx) => taxRepository.creditedBefore(invoice.document.id, tx))
    ).toBe(60_000)
  })

  it('queues an issue and an invite on the billing row and settles both without a deadlock', async () => {
    const { tenant, owner } = await workspace()
    const holder = await holdBillingRow(tenant.id)

    const issuing = issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
    expect(await waitForWaiter(holder.pid, issuing)).toBe(true)
    const inviting = invite(
      { userId: owner.id },
      tenant.id,
      `tax-race-${randomUUID()}@example.test`,
      'viewer'
    )
    const releasedAt = Date.now()
    holder.release()
    await holder.done
    const [issued, invited] = await Promise.allSettled([issuing, inviting])

    expect(issued).toMatchObject({ status: 'fulfilled', value: { outcome: 'issued' } })
    expect(invited).toMatchObject({ status: 'fulfilled' })
    // The claim is "no deadlock": Postgres reports one after deadlock_timeout (1 s), so a cycle would surface as a rejection well inside this 5 s bound.
    expect(Date.now() - releasedAt).toBeLessThan(5000)
  })

  it('gives the number back when the insert after allocation fails', async () => {
    const { tenant } = await workspace()
    const insertDocument = TaxRepository.prototype.insertDocument

    await withMutatedMethod(
      TaxRepository.prototype,
      'insertDocument',
      async function (this: TaxRepository, row: NewTaxDocument, tx: DbTransaction) {
        // A zero total breaks tax_documents_total_check after the number is taken.
        return insertDocument.call(
          this,
          { ...row, totalMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 },
          tx
        )
      },
      async () => {
        await expect(issueInvoice(tenant.id, charge(), scope, ISSUED_AT)).rejects.toThrow()
      }
    )

    const next = await issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
    expect(next).toMatchObject({ outcome: 'issued', document: { number: 'INV/26-27/00001' } })
    expect(await invoiceCounter()).toBe(1)
  })
})
