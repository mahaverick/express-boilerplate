/**
 * @file The tax reconciler against this worker's database and the fake
 * provider in Redis, with registration on and a fixed run time: a paid
 * charge gets one invoice and a processed refund one credit note, in that
 * order; the registration date, SEZ holds, late invoices and the refund
 * lookback are honoured; a provider outage fails the job for a retry and
 * keeps what was issued. Also the triggers: a sync, a webhook and its retry.
 */
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { UnrecoverableError } from 'bullmq'
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
import { ProviderError } from '@/errors/billing-provider-errors'
import {
  BILLING_TAX_RECONCILE_JOB,
  type BillingTaxReconcileJobData,
  type BillingWebhookJobData,
} from '@/jobs/billing.job'
import { BillingRepository } from '@/repositories/billing.repository'
import { EmailMessageRepository } from '@/repositories/email-message.repository'
import { PlanRepository } from '@/repositories/plan.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { syncTenantBilling } from '@/services/billing/billing-sync.service'
import { processBillingWebhookEvent } from '@/services/billing/billing-webhook.service'
import { FakeBillingProvider } from '@/services/billing/fake-billing-provider.service'
import { issueCreditNote } from '@/services/billing/tax-documents.service'
import { planTaxDocuments, reconcileTaxDocuments } from '@/services/billing/tax-reconcile.service'
import { sql, withTransaction } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getBillingQueue, getEmailQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { BILLING_ALERT_TEXT } from '@/utilities/billing-alert-text.utilities'
import { processBillingJob } from '@/workers/billing.worker'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  fakeSubscription,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  paymentsSwitch,
  plans,
  setBilling,
  workspace,
} from '../../../helpers/billing-api'
import { withMutatedMethod, withMutatedModule } from '../../../helpers/mutate'
import { deleteTrackedUsers } from '../../../helpers/platform-users'
import { queuedJobs } from '../../../helpers/queue-jobs'
import { resetTaxDocuments } from '../../../helpers/tax'
import { FIXTURE_SELLER } from '../../../helpers/tax-seller'

/**
 * Whether GST registration is on; a test turns it off and the hooks reset it.
 */
const gst = vi.hoisted(() => ({ on: true }))

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => (gst.on ? seller : null),
  }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-27T06:30:00.000Z')
const billingRepository = new BillingRepository()
const taxRepository = new TaxRepository()
const eventIds: string[] = []

beforeAll(loadPlans)

beforeEach(resetTaxDocuments)

afterEach(async () => {
  gst.on = true
  paymentsSwitch.on = true
  await resetTaxDocuments()
  await getBillingQueue().obliterate({ force: true })
  await getEmailQueue().obliterate({ force: true })
  if (eventIds.length > 0) {
    await sql`delete from billing_events where provider_event_id = any(${eventIds})`
    eventIds.length = 0
  }
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
 * Move every date of a subscription so its newest charge was paid at a time.
 * @param subscriptionId - The fake subscription.
 * @param at - When its newest charge was paid.
 * @returns The newest charge's payment id.
 */
async function paidAt(subscriptionId: string, at: Date): Promise<string> {
  const charges = await fake.listPaidCharges(subscriptionId)
  const latest = charges.at(-1)
  if (latest === undefined) throw new Error('setup: the subscription has no charge')
  await fake.fakeShiftBack(subscriptionId, latest.paidAt.getTime() - at.getTime())
  return latest.paymentId
}

/**
 * A workspace on a paid monthly subscription whose charge was paid at a time.
 * @param at - When it paid; an hour before the run by default.
 * @returns The workspace, its owner, the subscription and the payment.
 */
async function paying(at = new Date(NOW.getTime() - 60 * 60 * 1000)) {
  const { tenant, owner } = await workspace()
  const { subscriptionId } = await makePaying(tenant.id)
  const paymentId = await paidAt(subscriptionId, at)
  return { tenantId: tenant.id, ownerId: owner.id, subscriptionId, paymentId }
}

/**
 * A workspace's tax documents, in issue order.
 * @param tenantId - The workspace.
 * @returns Each document's fields the tests read, in the order they were issued (ids are time-ordered).
 */
async function documentsOf(tenantId: string) {
  const rows = await sql<
    {
      id: string
      type: string
      number: string
      payment_id: string | null
      refund_id: string | null
      original_document_id: string | null
      total_minor: number
      snapshot: { description: string; billingPeriod: { start: string; end: string } | null }
    }[]
  >`
    select id, type, number, payment_id, refund_id, original_document_id, total_minor, snapshot
    from tax_documents where tenant_id = ${tenantId} order by id`
  return [...rows]
}

/**
 * One field of each of a workspace's tax documents, in issue order.
 * @param tenantId - The workspace.
 * @param field - The field.
 * @returns The values.
 */
async function fieldOf<K extends 'type' | 'number' | 'payment_id'>(
  tenantId: string,
  field: K
): Promise<string[]> {
  const documents = await documentsOf(tenantId)
  return documents.map((document) => String(document[field]))
}

/**
 * The payloads of a workspace's `tax-reconcile` jobs that name payments.
 * @param tenantId - The workspace.
 * @returns The payloads.
 */
async function hintedJobsOf(tenantId: string): Promise<BillingTaxReconcileJobData[]> {
  const jobs = await taxJobsOf(tenantId)
  return jobs.filter((job) => job.data.paymentIds !== undefined).map((job) => job.data)
}

/**
 * A workspace's alerts of a kind, oldest first.
 * @param tenantId - The workspace.
 * @param kind - The alert kind.
 * @returns Their messages.
 */
async function alertsOf(tenantId: string, kind: string): Promise<string[]> {
  const rows = await sql<{ message: string }[]>`
    select message from billing_alerts where tenant_id = ${tenantId} and kind = ${kind}
    order by at, id`
  return rows.map((row) => row.message)
}

/**
 * The `tax-reconcile` jobs on the billing queue for a workspace.
 * @param tenantId - The workspace.
 * @returns The jobs.
 */
async function taxJobsOf(tenantId: string): Promise<Job<BillingTaxReconcileJobData>[]> {
  const jobs = await queuedJobs<BillingTaxReconcileJobData>(getBillingQueue())
  return jobs.filter(
    (job) => job.name === BILLING_TAX_RECONCILE_JOB && job.data.tenantId === tenantId
  )
}

/**
 * Set a stored fake refund's status, as Razorpay moves a pending refund on;
 * the fake has no hook for it, so the test rewrites its hash field.
 * @param paymentId - The refunded payment.
 * @param status - The new status of each of its refunds.
 */
async function setRefundStatus(paymentId: string, status: 'processed' | 'failed'): Promise<void> {
  const redis = await getRedis()
  const field = `refunds:${paymentId}`
  const stored = JSON.parse((await redis.hGet(redisKey('billing-fake'), field)) ?? '[]') as object[]
  await redis.hSet(
    redisKey('billing-fake'),
    field,
    JSON.stringify(stored.map((refund) => ({ ...refund, status })))
  )
}

/**
 * Store a webhook event, as the receipt does, and build its job payload.
 * @param eventType - The event type.
 * @param ids - The ids its body named.
 * @param ids.paymentId - The payment.
 * @param ids.subscriptionId - The subscription.
 * @returns The job payload.
 */
async function storedEvent(
  eventType: string,
  ids: { paymentId: string | null; subscriptionId: string | null }
): Promise<BillingWebhookJobData> {
  const providerEventId = `evt_TAX${randomUUID().replaceAll('-', '').slice(0, 12)}`
  eventIds.push(providerEventId)
  const [row] = await sql<{ id: string }[]>`
    insert into billing_events (provider, mode, provider_event_id, type)
    values ('fake', 'test', ${providerEventId}, ${eventType})
    returning id`
  return {
    eventRowId: row?.id ?? '',
    providerEventId,
    eventType,
    subscriptionId: ids.subscriptionId,
    paymentId: ids.paymentId,
    disputeId: null,
  }
}

/**
 * Save a workspace's tax details as its owner would.
 * @param tenantId - The workspace.
 * @param ownerId - Its owner.
 * @param isSez - Whether it is an SEZ unit.
 */
async function saveDetails(tenantId: string, ownerId: string, isSez: boolean): Promise<void> {
  await withTransaction((tx) =>
    taxRepository.insertDetails(
      {
        tenantId,
        gstin: '29ABCDE1234F1ZW',
        legalName: 'Acme Studio Pvt Ltd',
        addressLine1: '4 Park Street',
        addressLine2: null,
        city: 'Bengaluru',
        pincode: '560001',
        stateCode: '29',
        isSez,
        updatedBy: ownerId,
      },
      tx
    )
  )
}

describe('reconcileTaxDocuments', () => {
  it('issues one invoice for a paid charge, and nothing on a second run', async () => {
    const { tenantId, paymentId } = await paying()

    const first = await reconcileTaxDocuments(tenantId, { now: NOW })
    const second = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(first).toStrictEqual({
      skipped: null,
      issued: { invoices: 1, creditNotes: 0 },
      held: 0,
      late: { invoices: 0, creditNotes: 0 },
      overCredits: 0,
    })
    expect(second.issued).toStrictEqual({ invoices: 0, creditNotes: 0 })
    const documents = await documentsOf(tenantId)
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({
      type: 'invoice',
      number: 'INV/26-27/00001',
      payment_id: paymentId,
      total_minor: 99_900,
    })
    expect(documents[0]?.snapshot.description).toBe('Paid, Monthly, 27 Oct 2026 to 27 Nov 2026')
  })

  it('invoices a charge paid at the registration date and not one a second earlier', async () => {
    const early = await paying(new Date(FIXTURE_SELLER.effectiveFrom.getTime() - 1000))
    const onTime = await paying(FIXTURE_SELLER.effectiveFrom)

    await reconcileTaxDocuments(early.tenantId, { now: NOW })
    await reconcileTaxDocuments(onTime.tenantId, { now: NOW })

    expect(await documentsOf(early.tenantId)).toStrictEqual([])
    expect(await fieldOf(onTime.tenantId, 'payment_id')).toStrictEqual([onTime.paymentId])
  })

  it('numbers a charge paid at 23:59 IST on 31 March in the next year when issued at 00:01, and not late', async () => {
    const { tenantId } = await paying(new Date('2027-03-31T18:29:00.000Z'))

    const report = await reconcileTaxDocuments(tenantId, {
      now: new Date('2027-03-31T18:31:00.000Z'),
    })

    expect(report.late).toStrictEqual({ invoices: 0, creditNotes: 0 })
    expect(await fieldOf(tenantId, 'number')).toStrictEqual(['INV/27-28/00001'])
    expect(await alertsOf(tenantId, 'tax_invoice_late')).toStrictEqual([])
  })

  it('issues the invoice, then the credit note of its refund, in one run', async () => {
    const { tenantId, paymentId } = await paying()
    const refundId = await fake.fakeRefund(paymentId, 50_000)

    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.issued).toStrictEqual({ invoices: 1, creditNotes: 1 })
    const [invoice, note] = await documentsOf(tenantId)
    expect(invoice).toMatchObject({ type: 'invoice', number: 'INV/26-27/00001' })
    expect(note).toMatchObject({
      type: 'credit_note',
      number: 'CN/26-27/00001',
      refund_id: refundId,
      original_document_id: invoice?.id,
      total_minor: 50_000,
    })
  })

  it('credits a refund only once it is processed', async () => {
    const { tenantId, paymentId } = await paying()
    await fake.fakeRefund(paymentId, 50_000, 'pending')

    await reconcileTaxDocuments(tenantId, { now: NOW })
    expect(await fieldOf(tenantId, 'type')).toStrictEqual(['invoice'])

    await setRefundStatus(paymentId, 'processed')
    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.issued).toStrictEqual({ invoices: 0, creditNotes: 1 })
  })

  it('invoices a duplicate subscription the sync refunded, and credits its refund', async () => {
    const { tenant } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const duplicateId = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(duplicateId, 'active')
    await setBilling(tenant.id, { pendingSubscriptionId: duplicateId })
    await syncTenantBilling(tenant.id, 'confirm')
    const [duplicateCharge] = await fake.listPaidCharges(duplicateId)
    const [currentCharge] = await fake.listPaidCharges(subscriptionId)

    const report = await reconcileTaxDocuments(tenant.id, { now: new Date(Date.now() + 60_000) })

    expect(report.issued).toStrictEqual({ invoices: 2, creditNotes: 1 })
    const documents = await documentsOf(tenant.id)
    const invoiced = documents
      .filter((document) => document.type === 'invoice')
      .map((document) => document.payment_id)
    expect(invoiced).toHaveLength(2)
    expect(new Set(invoiced)).toStrictEqual(
      new Set([currentCharge?.paymentId, duplicateCharge?.paymentId])
    )
    expect(documents.find((document) => document.type === 'credit_note')).toMatchObject({
      payment_id: duplicateCharge?.paymentId,
      total_minor: 99_900,
    })
  })

  it('holds an SEZ charge with one alert, and raises none on a second run', async () => {
    const { tenantId, ownerId, paymentId } = await paying()
    await saveDetails(tenantId, ownerId, true)

    const first = await reconcileTaxDocuments(tenantId, { now: NOW })
    const second = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(first.held).toBe(1)
    expect(second.held).toBe(0)
    expect(await documentsOf(tenantId)).toStrictEqual([])
    expect(await alertsOf(tenantId, 'tax_held_sez')).toStrictEqual([
      BILLING_ALERT_TEXT.taxHeldSez(paymentId, 99_900),
    ])
  })

  it('skips with registration off and writes nothing', async () => {
    const { tenantId } = await paying()
    gst.on = false

    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.skipped).toBe('registration_off')
    expect(await documentsOf(tenantId)).toStrictEqual([])
  })

  it('raises one late-invoice alert naming the number for a charge paid 31 days before', async () => {
    const { tenantId } = await paying(new Date(NOW.getTime() - 31 * DAY))

    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.late).toStrictEqual({ invoices: 1, creditNotes: 0 })
    expect(await alertsOf(tenantId, 'tax_invoice_late')).toStrictEqual([
      BILLING_ALERT_TEXT.taxInvoiceLate(1, 'INV/26-27/00001', 'INV/26-27/00001'),
    ])
  })

  it('skips a subscription the provider does not know and invoices the rest', async () => {
    const { tenantId, paymentId } = await paying()
    await billingRepository.recordTrackedSubscription(
      tenantId,
      { kind: 'fake', mode: 'test' },
      'sub_FAKEunknown0001',
      'duplicate'
    )

    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.issued.invoices).toBe(1)
    expect(await fieldOf(tenantId, 'payment_id')).toStrictEqual([paymentId])
  })

  it('fails the job for a retry on a provider outage and keeps what was issued', async () => {
    const { tenantId, paymentId } = await paying()
    await reconcileTaxDocuments(tenantId, { now: NOW })
    await fake.fakeRefund(paymentId, 50_000)
    const job = {
      name: BILLING_TAX_RECONCILE_JOB,
      id: 'tax-outage',
      data: { tenantId },
      attemptsMade: 0,
      updateData: () => Promise.resolve(),
    } as unknown as Job

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listRefunds',
      () => Promise.reject(new ProviderError('GET /payments/x/refunds', 503)),
      async () => {
        const error = await processBillingJob(job).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(ProviderError)
        expect(error).not.toBeInstanceOf(UnrecoverableError)
      }
    )

    expect(await fieldOf(tenantId, 'type')).toStrictEqual(['invoice'])
    await processBillingJob(job)
    expect(await fieldOf(tenantId, 'type')).toStrictEqual(['invoice', 'credit_note'])
  })
})

/**
 * The document numbers a workspace was mailed about, sorted.
 * @param tenantId - The workspace.
 * @returns One number per mail.
 */
async function mailedNumbersOf(tenantId: string): Promise<string[]> {
  const rows = await sql<{ number: string }[]>`
    select variables->>'documentNumber' as number from email_messages
    where tenant_id = ${tenantId} and template_key = 'tax_document_issued'`
  return rows.map((row) => row.number).toSorted()
}

describe('reconcileTaxDocuments provider refusals and limits', () => {
  it('skips a payment whose refunds the provider refuses to read, and issues the rest', async () => {
    const { tenantId, paymentId } = await paying()
    await fake.fakeRefund(paymentId, 50_000)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listRefunds',
      () => Promise.reject(new ProviderError('GET /payments/x/refunds', 400)),
      async () => {
        const report = await reconcileTaxDocuments(tenantId, { now: NOW })
        expect(report.issued).toStrictEqual({ invoices: 1, creditNotes: 0 })
      }
    )

    expect(warn).toHaveBeenCalledWith(
      'A tax run skipped a payment whose refunds the provider refused to read',
      { paymentId }
    )
    warn.mockRestore()
  })

  it('reads the newest 50 tracked subscriptions and logs the workspace and its count', async () => {
    const { tenantId } = await paying()
    for (let n = 0; n < 51; n += 1) {
      await billingRepository.recordTrackedSubscription(
        tenantId,
        { kind: 'fake', mode: 'test' },
        `sub_FAKEcap${String(n).padStart(4, '0')}`,
        'duplicate'
      )
    }
    const count = await billingRepository.countTrackedSubscriptions(tenantId, {
      kind: 'fake',
      mode: 'test',
    })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const listPaidCharges = vi.spyOn(FakeBillingProvider.prototype, 'listPaidCharges')

    await planTaxDocuments(tenantId, { now: NOW })

    expect(count).toBe(51)
    expect(warn).toHaveBeenCalledWith(
      'A tax run read only the newest tracked subscriptions of a workspace',
      { tenantId, count, read: 50 }
    )
    // The billing row's own subscription, then the newest 50 tracked: the oldest is left out.
    const read = new Set(listPaidCharges.mock.calls.map(([id]) => id))
    expect(read.size).toBe(51)
    expect(read.has('sub_FAKEcap0000')).toBe(false)
    warn.mockRestore()
    listPaidCharges.mockRestore()
  })

  it('prints Paid plan on the invoice line when the plan name holds a script the PDF cannot draw', async () => {
    const { tenantId } = await paying()
    const findPlan = PlanRepository.prototype.findPlan

    await withMutatedMethod(
      PlanRepository.prototype,
      'findPlan',
      async function (this: PlanRepository, ...arguments_) {
        const plan = await findPlan.apply(this, arguments_)
        // Devanagari for "Pro".
        return plan === undefined ? plan : { ...plan, name: '\u092A\u094D\u0930\u094B' }
      },
      async () => {
        await reconcileTaxDocuments(tenantId, { now: NOW })
      }
    )

    const [invoice] = await documentsOf(tenantId)
    expect(invoice?.snapshot.description).toMatch(/^Paid plan, Monthly, /)
  })

  it('falls back to the current period for a charge the provider lists without dates', async () => {
    const { tenantId } = await paying()
    const listPaidCharges = FakeBillingProvider.prototype.listPaidCharges

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listPaidCharges',
      async function (this: FakeBillingProvider, ...arguments_) {
        const charges = await listPaidCharges.apply(this, arguments_)
        return charges.map((charge) => ({ ...charge, billingStart: null, billingEnd: null }))
      },
      async () => {
        await reconcileTaxDocuments(tenantId, { now: NOW })
      }
    )

    const [invoice] = await documentsOf(tenantId)
    expect(invoice?.snapshot.billingPeriod).toStrictEqual({
      start: '2026-10-27',
      end: '2026-11-27',
    })
    expect(invoice?.snapshot.description).toBe('Paid, Monthly, 27 Oct 2026 to 27 Nov 2026')
  })

  it('gives an undated charge paid outside the current period no dates', async () => {
    const { tenantId } = await paying()
    const listPaidCharges = FakeBillingProvider.prototype.listPaidCharges
    const fetchSubscription = FakeBillingProvider.prototype.fetchSubscription

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listPaidCharges',
      async function (this: FakeBillingProvider, ...arguments_) {
        const charges = await listPaidCharges.apply(this, arguments_)
        return charges.map((charge) => ({ ...charge, billingStart: null, billingEnd: null }))
      },
      async () => {
        await withMutatedMethod(
          FakeBillingProvider.prototype,
          'fetchSubscription',
          async function (this: FakeBillingProvider, ...arguments_) {
            const subscription = await fetchSubscription.apply(this, arguments_)
            return {
              ...subscription,
              currentStart: new Date(NOW.getTime() + 30 * DAY),
              currentEnd: new Date(NOW.getTime() + 60 * DAY),
            }
          },
          async () => {
            await reconcileTaxDocuments(tenantId, { now: NOW })
          }
        )
      }
    )

    const [invoice] = await documentsOf(tenantId)
    expect(invoice?.snapshot.billingPeriod).toBeNull()
    expect(invoice?.snapshot.description).toBe('Paid, Monthly')
  })

  it("keeps a charge's own dates when the subscription's period differs", async () => {
    const { tenantId } = await paying()
    const fetchSubscription = FakeBillingProvider.prototype.fetchSubscription

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'fetchSubscription',
      async function (this: FakeBillingProvider, ...arguments_) {
        const subscription = await fetchSubscription.apply(this, arguments_)
        return {
          ...subscription,
          currentStart: new Date(NOW.getTime() - 2 * DAY),
          currentEnd: new Date(NOW.getTime() + 28 * DAY),
        }
      },
      async () => {
        await reconcileTaxDocuments(tenantId, { now: NOW })
      }
    )

    const [invoice] = await documentsOf(tenantId)
    expect(invoice?.snapshot.billingPeriod).toStrictEqual({
      start: '2026-10-27',
      end: '2026-11-27',
    })
    expect(invoice?.snapshot.description).toBe('Paid, Monthly, 27 Oct 2026 to 27 Nov 2026')
  })

  it('issues an undated charge with no period when the subscription read is refused', async () => {
    const { tenantId } = await paying()
    const listPaidCharges = FakeBillingProvider.prototype.listPaidCharges

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'listPaidCharges',
      async function (this: FakeBillingProvider, ...arguments_) {
        const charges = await listPaidCharges.apply(this, arguments_)
        return charges.map((charge) => ({ ...charge, billingStart: null, billingEnd: null }))
      },
      async () => {
        await withMutatedMethod(
          FakeBillingProvider.prototype,
          'fetchSubscription',
          () => Promise.reject(new ProviderError('GET /subscriptions/x', 404)),
          async () => {
            await reconcileTaxDocuments(tenantId, { now: NOW })
          }
        )
      }
    )

    const [invoice] = await documentsOf(tenantId)
    expect(invoice?.snapshot.billingPeriod).toBeNull()
    expect(invoice?.snapshot.description).toBe('Paid, Monthly')
  })
})

describe('reconcileTaxDocuments emails', () => {
  it('mails the owner a link to each invoice and credit note a run issues, once', async () => {
    const { tenantId, paymentId } = await paying()
    await fake.fakeRefund(paymentId, 50_000)

    await reconcileTaxDocuments(tenantId, { now: NOW })
    await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(await mailedNumbersOf(tenantId)).toStrictEqual(['CN/26-27/00001', 'INV/26-27/00001'])
  })

  it('issues a backfilled charge paid 8 days before and mails nothing for it', async () => {
    const { tenantId } = await paying(new Date(NOW.getTime() - 8 * DAY))

    const report = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(report.issued.invoices).toBe(1)
    expect(await mailedNumbersOf(tenantId)).toStrictEqual([])
  })

  it('mails a charge paid 6 days before', async () => {
    const { tenantId } = await paying(new Date(NOW.getTime() - 6 * DAY))

    await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(await mailedNumbersOf(tenantId)).toStrictEqual(['INV/26-27/00001'])
  })

  it('finishes the run when a mail cannot be queued', async () => {
    const { tenantId } = await paying()

    await withMutatedMethod(
      EmailMessageRepository.prototype,
      'createQueued',
      () => Promise.reject(new Error('probe: the insert failed')),
      async () => {
        const report = await reconcileTaxDocuments(tenantId, { now: NOW })
        expect(report.issued.invoices).toBe(1)
      }
    )

    expect(await fieldOf(tenantId, 'type')).toStrictEqual(['invoice'])
  })

  it('mails what committed before a later issue fails the run', async () => {
    const { tenantId, paymentId } = await paying()
    await fake.fakeRefund(paymentId, 50_000)
    const failure = new Error('the credit note failed')

    await withMutatedModule(
      '@/services/billing/tax-documents.service',
      { issueCreditNote: () => Promise.reject(failure) },
      () => import('@/services/billing/tax-reconcile.service'),
      async (subject) => {
        await expect(subject.reconcileTaxDocuments(tenantId, { now: NOW })).rejects.toBe(failure)
      }
    )

    expect(await mailedNumbersOf(tenantId)).toStrictEqual(['INV/26-27/00001'])
  })
})

describe('reconcileTaxDocuments alerts', () => {
  it('raises no credit note and one tax_issue_failed alert for a refund larger than what is left', async () => {
    const { tenantId, paymentId } = await paying()
    await reconcileTaxDocuments(tenantId, { now: NOW })
    const [invoice] = await documentsOf(tenantId)
    await issueCreditNote(
      tenantId,
      invoice?.id ?? '',
      { amountMinor: 90_000, refundId: null, reason: 'Lost dispute' },
      NOW
    )
    const refundId = await fake.fakeRefund(paymentId, 50_000)

    const first = await reconcileTaxDocuments(tenantId, { now: NOW })
    const second = await reconcileTaxDocuments(tenantId, { now: NOW })

    expect(first.overCredits).toBe(1)
    expect(second.overCredits).toBe(1)
    expect(first.issued.creditNotes).toBe(0)
    expect(await fieldOf(tenantId, 'type')).toStrictEqual(['invoice', 'credit_note'])
    expect(await alertsOf(tenantId, 'tax_issue_failed')).toStrictEqual([
      BILLING_ALERT_TEXT.taxRefundOverCredit(refundId, 50_000, 9900, 'INV/26-27/00001'),
    ])
  })

  it('raises one late credit-note alert for a note issued after 30 November of the next year', async () => {
    const { tenantId, paymentId } = await paying()
    await reconcileTaxDocuments(tenantId, { now: NOW })
    await fake.fakeRefund(paymentId, 50_000)
    const late = new Date('2027-11-30T18:30:00.000Z')

    const report = await reconcileTaxDocuments(tenantId, { now: late, paymentIds: [paymentId] })
    await reconcileTaxDocuments(tenantId, { now: late, paymentIds: [paymentId] })

    expect(report.late).toStrictEqual({ invoices: 0, creditNotes: 1 })
    expect(await fieldOf(tenantId, 'number')).toStrictEqual(['INV/26-27/00001', 'CN/27-28/00001'])
    expect(await alertsOf(tenantId, 'tax_credit_note_late')).toStrictEqual([
      BILLING_ALERT_TEXT.taxCreditNoteLate('CN/27-28/00001', 'INV/26-27/00001', 2027),
    ])
  })

  it('keeps the late-invoice and SEZ-hold alerts of what committed before a run fails', async () => {
    const late = await paying(new Date(NOW.getTime() - 31 * DAY))
    await fake.fakeRefund(late.paymentId, 10_000)
    const sez = await paying(new Date(NOW.getTime() - 2 * 60 * 60 * 1000))
    await reconcileTaxDocuments(sez.tenantId, { now: NOW })
    await saveDetails(sez.tenantId, sez.ownerId, true)
    await fake.fakeAdvance(sez.subscriptionId, 'active')
    const charges = await fake.listPaidCharges(sez.subscriptionId)
    const held = charges.find((charge) => charge.paymentId !== sez.paymentId)
    await fake.fakeRefund(sez.paymentId, 10_000)
    const failure = new Error('the credit note failed')

    await withMutatedModule(
      '@/services/billing/tax-documents.service',
      { issueCreditNote: () => Promise.reject(failure) },
      () => import('@/services/billing/tax-reconcile.service'),
      async (subject) => {
        await expect(subject.reconcileTaxDocuments(late.tenantId, { now: NOW })).rejects.toBe(
          failure
        )
        await expect(subject.reconcileTaxDocuments(sez.tenantId, { now: NOW })).rejects.toBe(
          failure
        )
      }
    )

    // The SEZ workspace's first charge took INV/26-27/00001 before it became an SEZ unit.
    expect(await alertsOf(late.tenantId, 'tax_invoice_late')).toStrictEqual([
      BILLING_ALERT_TEXT.taxInvoiceLate(1, 'INV/26-27/00002', 'INV/26-27/00002'),
    ])
    expect(await alertsOf(sez.tenantId, 'tax_held_sez')).toStrictEqual([
      BILLING_ALERT_TEXT.taxHeldSez(held?.paymentId ?? '', 99_900),
    ])
  })

  it('raises one tax_held_sez alert for a processed refund of a held charge, and issues nothing', async () => {
    const { tenantId, ownerId, paymentId } = await paying()
    await saveDetails(tenantId, ownerId, true)
    await reconcileTaxDocuments(tenantId, { now: NOW })
    await fake.fakeRefund(paymentId, 20_000, 'pending')
    const refundId = await fake.fakeRefund(paymentId, 50_000)

    const first = await reconcileTaxDocuments(tenantId, { now: NOW })
    await reconcileTaxDocuments(tenantId, { now: NOW, paymentIds: [paymentId] })

    expect(first.issued).toStrictEqual({ invoices: 0, creditNotes: 0 })
    expect(await documentsOf(tenantId)).toStrictEqual([])
    expect(await alertsOf(tenantId, 'tax_held_sez')).toStrictEqual([
      BILLING_ALERT_TEXT.taxHeldSez(paymentId, 99_900),
      BILLING_ALERT_TEXT.taxHeldSezRefunded(paymentId, 50_000, refundId),
    ])
  })

  it('reads the refunds of a held charge paid 201 days before only when hinted', async () => {
    const { tenantId, ownerId, paymentId } = await paying(new Date(NOW.getTime() - 201 * DAY))
    await saveDetails(tenantId, ownerId, true)
    await reconcileTaxDocuments(tenantId, { now: NOW })
    const refundId = await fake.fakeRefund(paymentId, 50_000)

    await reconcileTaxDocuments(tenantId, { now: NOW })
    const unhinted = await alertsOf(tenantId, 'tax_held_sez')
    await reconcileTaxDocuments(tenantId, { now: NOW, paymentIds: [paymentId] })

    expect(unhinted).toStrictEqual([BILLING_ALERT_TEXT.taxHeldSez(paymentId, 99_900)])
    expect(await alertsOf(tenantId, 'tax_held_sez')).toStrictEqual([
      BILLING_ALERT_TEXT.taxHeldSez(paymentId, 99_900),
      BILLING_ALERT_TEXT.taxHeldSezRefunded(paymentId, 50_000, refundId),
    ])
  })

  it('never invoices the trial authorisation payment, and its refund issues nothing', async () => {
    const { tenant } = await workspace()
    const subscriptionId = await fakeSubscription(
      { tenantId: tenant.id, priceId: plans.monthPriceId },
      'month',
      new Date(NOW.getTime() + 14 * DAY)
    )
    await fake.fakeAdvance(subscriptionId, 'authenticated')
    await setBilling(tenant.id, {
      state: 'trialing',
      providerSubscriptionId: subscriptionId,
      provider: 'fake',
      providerMode: 'test',
    })
    // The authorisation payment has no invoice, so it is no subscription's paid charge.
    const authorisation = `pay_FAKEauth${randomUUID().replaceAll('-', '').slice(0, 10)}`
    await fake.fakeRefund(authorisation, 500)
    const data = await storedEvent('refund.processed', {
      paymentId: authorisation,
      subscriptionId: null,
    })

    const plan = await planTaxDocuments(tenant.id, { now: NOW, paymentIds: [authorisation] })
    const report = await reconcileTaxDocuments(tenant.id, {
      now: NOW,
      paymentIds: [authorisation],
    })
    await processBillingWebhookEvent(data)

    expect(plan.invoices).toStrictEqual([])
    expect(plan.creditNotes).toStrictEqual([])
    expect(report.issued).toStrictEqual({ invoices: 0, creditNotes: 0 })
    expect(await documentsOf(tenant.id)).toStrictEqual([])
    expect(await taxJobsOf(tenant.id)).toStrictEqual([])
  })
})

describe('planTaxDocuments', () => {
  it('lists no refunds of a fully credited invoice or a payment 201 days old unless hinted', async () => {
    const credited = await paying()
    await fake.fakeRefund(credited.paymentId, 99_900)
    await reconcileTaxDocuments(credited.tenantId, { now: NOW })
    const old = await paying(new Date(NOW.getTime() - 201 * DAY))
    await reconcileTaxDocuments(old.tenantId, { now: NOW })
    const original = FakeBillingProvider.prototype.listRefunds
    const listRefunds = vi.fn(async function (this: FakeBillingProvider, id: string) {
      return original.call(this, id)
    })

    await withMutatedMethod(FakeBillingProvider.prototype, 'listRefunds', listRefunds, async () => {
      await planTaxDocuments(credited.tenantId, { now: NOW })
      await planTaxDocuments(old.tenantId, { now: NOW })
      expect(listRefunds).not.toHaveBeenCalled()
      await planTaxDocuments(old.tenantId, { now: NOW, paymentIds: [old.paymentId] })
      await planTaxDocuments(credited.tenantId, { now: NOW, paymentIds: [credited.paymentId] })
    })

    expect(listRefunds.mock.calls).toStrictEqual([[old.paymentId], [credited.paymentId]])
  })

  it('plans a recent unrefunded charge with its refund lookup', async () => {
    const { tenantId, paymentId } = await paying()

    const plan = await planTaxDocuments(tenantId, { now: NOW })

    expect(plan.skipped).toBeNull()
    expect(
      plan.invoices.map((invoice) => [invoice.charge.paymentId, invoice.isLate])
    ).toStrictEqual([[paymentId, false]])
    expect(plan.creditNotes).toStrictEqual([])
  })
})

describe('tax reconcile triggers', () => {
  it('queues one prioritised job after a sync, one after a sync with a follow-up, and none with payments off', async () => {
    const { tenantId } = await paying()
    expect(await syncTenantBilling(tenantId, 'job', { now: NOW })).toMatchObject({
      outcome: 'synced',
    })
    const jobs = await taxJobsOf(tenantId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.opts.priority).toBe(10)
    expect(jobs[0]?.data).toStrictEqual({ tenantId })

    await getBillingQueue().obliterate({ force: true })
    const graced = await paying()
    await fake.fakeAdvance(graced.subscriptionId, 'halted')
    const now = new Date()
    await setBilling(graced.tenantId, {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 10 * DAY),
      haltedAt: new Date(now.getTime() - 8 * DAY),
    })
    await syncTenantBilling(graced.tenantId, 'job', { now })
    // The grace cancel ran, so the sync ran its follow-up sync.
    const cancelled = await fake.fetchSubscription(graced.subscriptionId)
    expect(cancelled.status).toBe('cancelled')
    expect(await taxJobsOf(graced.tenantId)).toHaveLength(1)

    paymentsSwitch.on = false
    const off = await paying()
    expect(await syncTenantBilling(off.tenantId, 'job')).toMatchObject({ outcome: 'payments_off' })
    expect(await taxJobsOf(off.tenantId)).toStrictEqual([])
  })

  it('queues nothing for a webhook attempt that fails for a retry, and a hinted job on its retry', async () => {
    const { tenantId, paymentId } = await paying()
    const data = await storedEvent('refund.processed', { paymentId, subscriptionId: null })

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'findSubscriptionIdForPayment',
      () => Promise.reject(new ProviderError('GET /payments/x', 503)),
      async () => {
        await expect(processBillingWebhookEvent(data)).rejects.toBeInstanceOf(ProviderError)
      }
    )
    expect(await taxJobsOf(tenantId)).toStrictEqual([])

    await processBillingWebhookEvent(data)

    // The sync it runs queues its own unhinted run too.
    expect(await hintedJobsOf(tenantId)).toStrictEqual([{ tenantId, paymentIds: [paymentId] }])
  })

  it('queues a hinted job for the workspace of a refunded duplicate no row holds', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const duplicateId = await fakeSubscription({ tenantId: tenant.id, priceId: plans.monthPriceId })
    await fake.fakeAdvance(duplicateId, 'active')
    await setBilling(tenant.id, { pendingSubscriptionId: duplicateId })
    await syncTenantBilling(tenant.id, 'confirm')
    await getBillingQueue().obliterate({ force: true })
    const [charge] = await fake.listPaidCharges(duplicateId)
    const paymentId = charge?.paymentId ?? ''
    const data = await storedEvent('refund.processed', { paymentId, subscriptionId: null })

    await processBillingWebhookEvent(data)

    expect(await hintedJobsOf(tenant.id)).toStrictEqual([
      { tenantId: tenant.id, paymentIds: [paymentId] },
    ])
  })

  it('queues a hinted job for a refund whose subscription the provider does not know', async () => {
    const { tenantId, paymentId } = await paying()
    await reconcileTaxDocuments(tenantId, { now: NOW })
    const data = await storedEvent('refund.processed', { paymentId, subscriptionId: null })

    await withMutatedMethod(
      FakeBillingProvider.prototype,
      'findSubscriptionIdForPayment',
      () =>
        Promise.reject(new ProviderError('GET /payments/x', 400, { code: 'BAD_REQUEST_ERROR' })),
      () => processBillingWebhookEvent(data)
    )

    const [event] = await sql<{ error: string | null }[]>`
      select error from billing_events where id = ${data.eventRowId}`
    expect(event?.error).toBe('unknown_subscription')
    const jobs = await taxJobsOf(tenantId)
    expect(jobs.map((job) => job.data)).toStrictEqual([{ tenantId, paymentIds: [paymentId] }])
  })
})
