/**
 * @file Issuing tax documents under concurrency: each payment gets one
 * invoice and each refund one credit note, numbers are used once with no
 * gap, parallel credit notes never credit more than the invoice, an issue
 * and an invite on one workspace queue on its billing row without a
 * deadlock, and a failed insert gives its number back.
 *
 * The races pause the first transaction at a seam after it holds the
 * billing row, then prove the second is queued behind it
 * (`waitForWaiter`) before releasing it, so the two always overlap. Without
 * the billing-row lock the second would not queue and each such test fails.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { sql as sqlTag } from 'drizzle-orm'
import { PgTransaction } from 'drizzle-orm/pg-core'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { NewTaxDocument } from '@/database/models/tax.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { issueCreditNote, issueInvoice } from '@/services/billing/tax-documents.service'
import {
  sql,
  withTransaction,
  type DbExecutor,
  type DbTransaction,
} from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { invite } from '@/services/tenant-invitation.service'
import type { ProviderCharge } from '@/types/billing'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { backendPid, deferred, untilSignalled, waitForWaiter } from '../../../helpers/lock-probe'
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

const taxRepository = new TaxRepository()
const tenantRepository = new TenantRepository()
const scope = { kind: 'razorpay', mode: 'test' } as const
const ISSUED_AT = new Date('2026-10-27T06:30:00.000Z')

const tenantIds: string[] = []

beforeEach(resetTaxDocuments)

// Seams still paused when a test fails; released first, so their transactions end and free the pool.
const openSeams: Array<() => void> = []

afterEach(async () => {
  for (const release of openSeams.splice(0)) release()
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
 * A stand-in for a repository method that pauses its first call until
 * released, after reporting the backend pid of the transaction it was
 * given (its last argument). Later calls run straight through.
 */
interface PausedSeam<TArguments extends unknown[], TResult> {
  implementation: (...arguments_: TArguments) => Promise<TResult>
  /**
   * Resolves with the paused transaction's backend pid.
   */
  reached: Promise<number>
  release: () => void
}

/**
 * Build a seam that pauses the first call of `original`.
 * @param original - The real method, called with the same `this` and arguments.
 * @returns The stand-in, its arrival signal and its release.
 */
function pauseFirstCall<TArguments extends unknown[], TResult>(
  original: (...arguments_: TArguments) => Promise<TResult>
): PausedSeam<TArguments, TResult> {
  const reached = deferred<number>()
  const released = deferred()
  let isFirst = true
  openSeams.push(() => released.resolve())
  return {
    implementation: async function (this: unknown, ...arguments_: TArguments): Promise<TResult> {
      if (isFirst) {
        isFirst = false
        const tx = arguments_.at(-1)
        // Every paused seam takes its transaction last; anything else would probe the wrong backend.
        if (!(tx instanceof PgTransaction)) {
          throw new TypeError(
            'pauseFirstCall: the paused call got no transaction as its last argument'
          )
        }
        reached.resolve(await backendPid(tx as DbExecutor))
        await released.promise
      }
      return original.apply(this, arguments_)
    },
    reached: reached.promise,
    release: () => released.resolve(),
  }
}

/**
 * Issue an invoice for a fresh workspace and fail unless it was issued.
 */
async function invoiced(tenantId: string) {
  const result = await issueInvoice(tenantId, charge(), scope, ISSUED_AT)
  if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
  return result.document
}

describe('issuing under concurrency', () => {
  it('invoices one payment once when a second issue overlaps the first', async () => {
    const { tenant } = await workspace()
    const paid = charge()
    const seam = pauseFirstCall(TaxRepository.prototype.findInvoiceByPayment)

    await withMutatedMethod(
      TaxRepository.prototype,
      'findInvoiceByPayment',
      seam.implementation,
      async () => {
        const first = issueInvoice(tenant.id, paid, scope, ISSUED_AT)
        const firstPid = await untilSignalled(seam.reached, first, 'the first issue')
        const second = issueInvoice(tenant.id, paid, scope, ISSUED_AT)
        expect(await waitForWaiter(firstPid, second)).toBe(true)
        seam.release()

        const results = await Promise.all([first, second])
        expect(results.map((result) => result.outcome)).toStrictEqual(['issued', 'exists'])
      }
    )
    expect(await invoiceCounter()).toBe(1)
  })

  it('numbers 10 parallel invoices across 3 workspaces 1 to 10, each once, queued at the counter', async () => {
    const tenants = await Promise.all([workspace(), workspace(), workspace()])
    await sql`insert into tax_document_counters (type, financial_year, last_number)
      values ('invoice', '26-27', 0)`
    const locked = deferred<number>()
    const released = deferred()
    openSeams.push(() => released.resolve())
    // A barrier: hold the counter, so the issues start together and the first one queues on it.
    const holder = withTransaction(async (tx) => {
      await tx.execute(
        sqlTag`select 1 from tax_document_counters
          where type = 'invoice' and financial_year = '26-27' for no key update`
      )
      locked.resolve(await backendPid(tx))
      await released.promise
    })
    const holderPid = await locked.promise

    const issues = Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        issueInvoice(tenants[index % 3]!.tenant.id, charge(), scope, ISSUED_AT)
      )
    )
    expect(await waitForWaiter(holderPid, issues)).toBe(true)
    released.resolve()
    await holder
    const results = await issues

    const numbers = results.map((result) => {
      if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
      return result.document.number
    })
    expect(numbers.toSorted()).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => `INV/26-27/${String(index + 1).padStart(5, '0')}`)
    )
    expect(await invoiceCounter()).toBe(10)
  })

  it('issues one of two overlapping credit notes that together exceed the invoice', async () => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const seam = pauseFirstCall(TaxRepository.prototype.creditedBefore)

    await withMutatedMethod(
      TaxRepository.prototype,
      'creditedBefore',
      seam.implementation,
      async () => {
        const first = issueCreditNote(
          tenant.id,
          invoice.id,
          { amountMinor: 60_000, refundId: 'rfnd_R1', reason: 'Refund' },
          ISSUED_AT
        )
        const firstPid = await untilSignalled(seam.reached, first, 'the first note')
        const second = issueCreditNote(
          tenant.id,
          invoice.id,
          { amountMinor: 60_000, refundId: 'rfnd_R2', reason: 'Refund' },
          ISSUED_AT
        )
        expect(await waitForWaiter(firstPid, second)).toBe(true)
        seam.release()

        const [issued, refused] = await Promise.all([first, second])
        expect(issued.outcome).toBe('issued')
        expect(refused).toStrictEqual({ outcome: 'over_credit', remainingMinor: 39_900 })
      }
    )
    expect(await withTransaction((tx) => taxRepository.creditedBefore(invoice.id, tx))).toBe(60_000)
  })

  it('credits one refund once when a second note for it overlaps the first', async () => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const credit = { amountMinor: 30_000, refundId: 'rfnd_SAME', reason: 'Refund' }
    const seam = pauseFirstCall(TaxRepository.prototype.creditedBefore)

    await withMutatedMethod(
      TaxRepository.prototype,
      'creditedBefore',
      seam.implementation,
      async () => {
        const first = issueCreditNote(tenant.id, invoice.id, credit, ISSUED_AT)
        const firstPid = await untilSignalled(seam.reached, first, 'the first note')
        const second = issueCreditNote(tenant.id, invoice.id, credit, ISSUED_AT)
        expect(await waitForWaiter(firstPid, second)).toBe(true)
        seam.release()

        const [issued, again] = await Promise.all([first, second])
        expect(issued.outcome).toBe('issued')
        expect(again).toStrictEqual({ outcome: 'exists', remainingMinor: 69_900 })
      }
    )
    const rows = await sql<{ last_number: number }[]>`
      select last_number from tax_document_counters
      where type = 'credit_note' and financial_year = '26-27'
    `
    expect(rows[0]?.last_number).toBe(1)
  })

  it('makes an invite wait on the billing row an issue holds, with no deadlock', async () => {
    const { tenant, owner } = await workspace()
    const seam = pauseFirstCall(TaxRepository.prototype.findInvoiceByPayment)

    await withMutatedMethod(
      TaxRepository.prototype,
      'findInvoiceByPayment',
      seam.implementation,
      async () => {
        const issuing = issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
        const issuePid = await untilSignalled(seam.reached, issuing, 'the issue')
        const inviting = invite(
          { userId: owner.id },
          tenant.id,
          `tax-race-${randomUUID()}@example.test`,
          'viewer'
        )
        expect(await waitForWaiter(issuePid, inviting)).toBe(true)
        const releasedAt = Date.now()
        seam.release()

        const [issued, invited] = await Promise.allSettled([issuing, inviting])
        expect(issued).toMatchObject({ status: 'fulfilled', value: { outcome: 'issued' } })
        expect(invited).toMatchObject({ status: 'fulfilled' })
        // The claim is "no deadlock": Postgres reports one after deadlock_timeout (1 s), so a cycle would surface as a rejection well inside this 5 s bound.
        expect(Date.now() - releasedAt).toBeLessThan(5000)
      }
    )
  })

  it('makes an issue wait on the billing row an invite holds, with no deadlock', async () => {
    const { tenant, owner } = await workspace()
    // The invite's seat check reads the invitation right after its seat lock.
    const seam = pauseFirstCall(TenantInvitationRepository.prototype.findRedeemableForEmail)

    await withMutatedMethod(
      TenantInvitationRepository.prototype,
      'findRedeemableForEmail',
      seam.implementation,
      async () => {
        const inviting = invite(
          { userId: owner.id },
          tenant.id,
          `tax-race-${randomUUID()}@example.test`,
          'viewer'
        )
        const invitePid = await untilSignalled(seam.reached, inviting, 'the invite')
        const issuing = issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
        expect(await waitForWaiter(invitePid, issuing)).toBe(true)
        const releasedAt = Date.now()
        seam.release()

        const [invited, issued] = await Promise.allSettled([inviting, issuing])
        expect(invited).toMatchObject({ status: 'fulfilled' })
        expect(issued).toMatchObject({ status: 'fulfilled', value: { outcome: 'issued' } })
        // The claim is "no deadlock": Postgres reports one after deadlock_timeout (1 s), so a cycle would surface as a rejection well inside this 5 s bound.
        expect(Date.now() - releasedAt).toBeLessThan(5000)
      }
    )
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
        await expect(issueInvoice(tenant.id, charge(), scope, ISSUED_AT)).rejects.toMatchObject({
          cause: { constraint_name: 'tax_documents_total_check' },
        })
      }
    )

    const next = await issueInvoice(tenant.id, charge(), scope, ISSUED_AT)
    expect(next).toMatchObject({ outcome: 'issued', document: { number: 'INV/26-27/00001' } })
    expect(await invoiceCounter()).toBe(1)
  })
})
