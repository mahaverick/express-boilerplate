/**
 * @file A workspace owner's tax documents end to end against the real
 * database and the fake payment provider: the document list and its filter,
 * the PDF download with its headers, its stable bytes and its analytics
 * event, who may call the routes, the billing read's tax flags, and the tax
 * links and status on every invoice row, owner and staff alike. Registration
 * and its effective date are switched per test through a mocked
 * `gstSellerConfig`.
 */
import { randomUUID } from 'node:crypto'
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
import { createApp } from '@/app'
import { TAX_DOCUMENTS_OWNER_ONLY_MESSAGE } from '@/constants/billing.constants'
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import type { User } from '@/database/models/user.model'
import { TaxRepository } from '@/repositories/tax.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { issueCreditNote, issueInvoice } from '@/services/billing/tax-documents.service'
import { withTransaction } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { ProviderCharge, ProviderInvoice } from '@/types/billing'
import { clearOutbox, outboxRowsOf } from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  workspace,
} from '../../helpers/billing-api'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { resetTaxDocuments } from '../../helpers/tax'
import { settle } from '../../helpers/timing'

/**
 * Whether GST registration is on, and the effective date a test sets; the
 * hooks reset both.
 */
const gst = vi.hoisted(() => ({ on: true, effectiveFrom: null as Date | null }))

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () =>
      gst.on ? { ...seller, effectiveFrom: gst.effectiveFrom ?? seller.effectiveFrom } : null,
  }
})

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const app = createApp()
const membershipRepository = new UserMembershipRepository()
const taxRepository = new TaxRepository()
const scope = { kind: 'fake', mode: 'test' } as const

const READ_DISABLED = 'Tax documents are off, and this workspace has none to download.'
const NOT_FOUND =
  'This workspace has no tax document with that ID. Reload the page to see its documents.'
/**
 * 00:00 IST on 1 April 2026, the fixture seller's effective date.
 */
const EFFECTIVE_FROM = new Date('2026-03-31T18:30:00.000Z')

beforeAll(async () => {
  await loadPlans()
})

beforeEach(async () => {
  gst.on = true
  gst.effectiveFrom = null
  await resetTaxDocuments()
  await clearOutbox()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  gst.on = true
  gst.effectiveFrom = null
  await resetTaxDocuments()
  await clearOutbox()
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await closeQueue()
  await forgetProviderPlans()
  await closeRedis()
})

/**
 * GET a tenant path as `user`.
 * @param user - The caller.
 * @param path - The path after `/api/v1/tenants/`.
 * @returns The response.
 */
function getAs(user: User, path: string) {
  return request(app)
    .get(`/api/v1/tenants/${path}`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
}

/**
 * GET a document's PDF as `user`, with the body read as bytes.
 * @param user - The caller.
 * @param slug - The workspace slug.
 * @param id - The document id.
 * @returns The response; `body` is a Buffer on success.
 */
function pdfAs(user: User, slug: string, id: string) {
  return getAs(user, `${slug}/billing/tax-documents/${id}/pdf`)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        done(null, Buffer.concat(chunks))
      })
    })
}

/**
 * The `data` of a success response.
 * @param body - The response body.
 * @returns Its data.
 */
function dataOf(body: unknown): Record<string, unknown> {
  return (body as { data: Record<string, unknown> }).data
}

/**
 * The items of a list response.
 * @param body - The response body.
 * @returns The items.
 */
function itemsOf(body: unknown): Record<string, unknown>[] {
  return (body as { data: { items: Record<string, unknown>[] } }).data.items
}

/**
 * A paid charge of ₹999 with fresh ids.
 * @param paymentId - The payment id; fresh when left out.
 * @returns The charge and the line it prints.
 */
function charge(paymentId = `pay_${randomUUID().slice(0, 12)}`): ProviderCharge & {
  description: string
} {
  return {
    invoiceId: `inv_${randomUUID().slice(0, 12)}`,
    subscriptionId: `sub_${randomUUID().slice(0, 12)}`,
    paymentId,
    amountMinor: 99_900,
    paidAt: new Date('2026-10-26T05:00:00.000Z'),
    billingStart: new Date('2026-10-26T05:00:00.000Z'),
    billingEnd: new Date('2026-11-26T05:00:00.000Z'),
    description: 'Paid, Monthly',
  }
}

/**
 * Issue an invoice for a charge and fail unless it was issued.
 * @param tenantId - The workspace.
 * @param paid - The charge.
 * @param now - The issue time.
 * @returns The invoice.
 */
async function invoiced(
  tenantId: string,
  paid = charge(),
  now = new Date('2026-10-27T06:30:00.000Z')
): Promise<TaxDocumentRecord> {
  const result = await issueInvoice(tenantId, paid, scope, now)
  if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
  return result.document
}

/**
 * Issue a credit note for a refund and fail unless it was issued.
 * @param tenantId - The workspace.
 * @param invoiceId - The invoice credited.
 * @param amountMinor - The refund amount.
 * @param now - The issue time.
 * @returns The credit note.
 */
async function credited(
  tenantId: string,
  invoiceId: string,
  amountMinor: number,
  now = new Date('2026-10-29T06:30:00.000Z')
): Promise<TaxDocumentRecord> {
  const result = await issueCreditNote(
    tenantId,
    invoiceId,
    { amountMinor, refundId: `rfnd_${randomUUID().slice(0, 12)}`, reason: 'Refund' },
    now
  )
  if (result.outcome !== 'issued') throw new Error(`expected issued, got ${result.outcome}`)
  return result.document
}

/**
 * Hold a payment as an SEZ charge.
 * @param tenantId - The workspace.
 * @param paymentId - The payment.
 * @param isResolved - Whether staff already marked it resolved.
 */
async function hold(tenantId: string, paymentId: string, isResolved = false): Promise<void> {
  await withTransaction((tx) =>
    taxRepository.insertHeld(
      {
        tenantId,
        provider: scope.kind,
        providerMode: scope.mode,
        paymentId,
        subscriptionId: 'sub_SEZ',
        amountMinor: 99_900,
        paidAt: new Date('2026-10-26T05:00:00.000Z'),
        ...(isResolved && { resolvedAt: new Date(), resolution: 'Issued by hand.' }),
      },
      tx
    )
  )
}

/**
 * One invoice row of a stubbed provider page.
 * @param id - The invoice id.
 * @param fields - The status, payment and paid time.
 * @returns The provider invoice.
 */
function row(id: string, fields: Pick<ProviderInvoice, 'status' | 'paymentId' | 'paidAt'>) {
  return {
    id,
    subscriptionId: 'sub_STUB',
    amountMinor: 99_900,
    currency: 'INR',
    issuedAt: '2026-10-26T05:00:00.000Z',
    url: null,
    ...fields,
  } satisfies ProviderInvoice
}

/**
 * Answer the provider's invoice list with fixed rows while `run` runs.
 * @param rows - The rows.
 * @param run - The test body.
 */
async function withInvoiceRows(rows: ProviderInvoice[], run: () => Promise<void>): Promise<void> {
  await withMutatedMethod(
    fake,
    'listInvoices',
    () => Promise.resolve({ items: rows, nextCursor: null }),
    run
  )
}

describe('GET /api/v1/tenants/:slug/billing/tax-documents', () => {
  it('lists the invoices and credit notes newest first, each with its links, and filters by type', async () => {
    const { tenant, owner } = await workspace()
    const first = await invoiced(tenant.id, charge(), new Date('2026-10-20T06:30:00.000Z'))
    const second = await invoiced(tenant.id, charge(), new Date('2026-10-27T06:30:00.000Z'))
    const note = await credited(tenant.id, first.id, 50_000)

    const response = await getAs(owner, `${tenant.slug}/billing/tax-documents`)
    const notes = await getAs(owner, `${tenant.slug}/billing/tax-documents?type=credit_note`)

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items.map((item) => item.number)).toStrictEqual([
      'CN/26-27/00001',
      'INV/26-27/00002',
      'INV/26-27/00001',
    ])
    expect(items[2]).toStrictEqual({
      id: first.id,
      type: 'invoice',
      number: 'INV/26-27/00001',
      financialYear: '26-27',
      issuedAt: '2026-10-20T06:30:00.000Z',
      amounts: {
        totalMinor: 99_900,
        taxableMinor: 84_661,
        cgstMinor: 7619,
        sgstMinor: 7620,
        igstMinor: 0,
        ratePercent: 18,
      },
      supply: 'intra',
      placeOfSupply: { code: '29', name: 'Karnataka' },
      buyerGstin: null,
      invoice: null,
      creditNotes: [{ id: note.id, number: 'CN/26-27/00001' }],
      creditedMinor: 50_000,
      noTaxReduction: false,
      reason: null,
      paymentId: first.paymentId,
      refundId: null,
    })
    expect(items[0]).toMatchObject({
      type: 'credit_note',
      invoice: { id: first.id, number: 'INV/26-27/00001' },
      creditNotes: [],
      creditedMinor: 0,
      reason: 'Refund',
      paymentId: first.paymentId,
      refundId: note.refundId,
    })
    expect(items[1]).toMatchObject({ id: second.id, creditNotes: [], creditedMinor: 0 })
    expect(dataOf(response.body).page).toStrictEqual({
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
      limit: 20,
    })
    expect(dataOf(response.body)).not.toHaveProperty('total')
    expect(itemsOf(notes.body).map((item) => item.id)).toStrictEqual([note.id])
  })

  it('lists a document whose subscription has no invoice row, such as a refunded duplicate', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    const duplicate = await invoiced(tenant.id, charge())

    const list = await getAs(owner, `${tenant.slug}/billing/tax-documents`)
    const invoices = await getAs(owner, `${tenant.slug}/billing/invoices`)

    expect(itemsOf(list.body).map((item) => item.id)).toStrictEqual([duplicate.id])
    expect(itemsOf(invoices.body).map((item) => item.taxDocument)).toStrictEqual([null])
  })

  it('refuses a search or a total, which the owner list has neither of', async () => {
    const { tenant, owner } = await workspace()

    const search = await getAs(owner, `${tenant.slug}/billing/tax-documents?search=INV`)
    const total = await getAs(owner, `${tenant.slug}/billing/tax-documents?total=1`)

    expect(search.status).toBe(400)
    expect(total.status).toBe(400)
  })

  it('answers the read 404 while registration is off and the workspace has no documents, and lists them once it has some', async () => {
    const { tenant, owner } = await workspace()
    gst.on = false

    const empty = await getAs(owner, `${tenant.slug}/billing/tax-documents`)

    expect(empty.status).toBe(404)
    expect(empty.body).toMatchObject({ code: 'tax_documents_disabled', message: READ_DISABLED })

    gst.on = true
    const document = await invoiced(tenant.id)
    gst.on = false
    const kept = await getAs(owner, `${tenant.slug}/billing/tax-documents`)
    const pdf = await pdfAs(owner, tenant.slug, document.id)

    expect(kept.status).toBe(200)
    expect(itemsOf(kept.body).map((item) => item.id)).toStrictEqual([document.id])
    expect(pdf.status).toBe(200)
  })

  it('refuses a member who is not an owner, and staff through platform access, with the owner-only 403', async () => {
    const { tenant } = await workspace()
    const document = await invoiced(tenant.id)
    const admin = await createTrackedUser()
    await membershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })
    const { user: staff } = await createTrackedStaff('owner')

    for (const user of [admin, staff]) {
      const list = await getAs(user, `${tenant.slug}/billing/tax-documents`)
      const pdf = await getAs(user, `${tenant.slug}/billing/tax-documents/${document.id}/pdf`)
      expect(list.status).toBe(403)
      expect(list.body).toMatchObject({ message: TAX_DOCUMENTS_OWNER_ONLY_MESSAGE })
      expect(pdf.status).toBe(403)
    }
  })
})

describe('GET /api/v1/tenants/:slug/billing/tax-documents/:id/pdf', () => {
  it('sends the PDF as a download that renders the same bytes 1 s later and in any time zone', async () => {
    const { tenant, owner } = await workspace()
    const document = await invoiced(tenant.id)

    vi.stubEnv('TZ', 'UTC')
    const first = await pdfAs(owner, tenant.slug, document.id)
    await settle(1000, 'the second render must start on a later clock second')
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const second = await pdfAs(owner, tenant.slug, document.id)

    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('application/pdf')
    expect(first.headers['content-disposition']).toBe('attachment; filename="INV-26-27-00001.pdf"')
    expect(first.headers['cache-control']).toBe('private, no-store')
    const bytes = first.body as Buffer
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect((second.body as Buffer).equals(bytes)).toBe(true)
  })

  it("answers 404 tax_document_not_found for another workspace's document and an unknown id", async () => {
    const mine = await workspace()
    const theirs = await workspace()
    await invoiced(mine.tenant.id)
    const other = await invoiced(theirs.tenant.id)

    const crossed = await pdfAs(mine.owner, mine.tenant.slug, other.id)
    const unknown = await pdfAs(mine.owner, mine.tenant.slug, randomUUID())

    for (const response of [crossed, unknown]) {
      expect(response.status).toBe(404)
      expect(JSON.parse((response.body as Buffer).toString('utf8'))).toMatchObject({
        code: 'tax_document_not_found',
        message: NOT_FOUND,
      })
    }
  })

  it('records one tax_document_downloaded event with the type and surface and no number', async () => {
    const { tenant, owner } = await workspace()
    const invoice = await invoiced(tenant.id)
    const note = await credited(tenant.id, invoice.id, 99_900)

    const response = await pdfAs(owner, tenant.slug, note.id)

    expect(response.status).toBe(200)
    const rows = await outboxRowsOf('tax_document_downloaded')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      distinctId: owner.id,
      properties: { type: 'credit_note', surface: 'web', $groups: { tenant: tenant.id } },
    })
    expect(JSON.stringify(rows[0]?.properties)).not.toContain(note.number)
    expect(rows[0]?.properties).not.toHaveProperty('number')
  })
})

describe('GET /api/v1/tenants/:slug/billing tax flags', () => {
  it('shows the owner registration and documents, and a member no documents', async () => {
    const { tenant, owner } = await workspace()
    await invoiced(tenant.id)
    const editor = await createTrackedUser()
    await membershipRepository.create({ userId: editor.id, tenantId: tenant.id, role: 'editor' })

    const ownerView = await getAs(owner, `${tenant.slug}/billing`)
    const editorView = await getAs(editor, `${tenant.slug}/billing`)

    expect(dataOf(ownerView.body)).toMatchObject({
      taxDocumentsEnabled: true,
      hasTaxDocuments: true,
    })
    expect(dataOf(editorView.body)).toMatchObject({
      taxDocumentsEnabled: true,
      hasTaxDocuments: false,
    })
  })

  it('reads both false while registration is off and the workspace has no documents', async () => {
    const { tenant, owner } = await workspace()
    gst.on = false

    const response = await getAs(owner, `${tenant.slug}/billing`)

    expect(dataOf(response.body)).toMatchObject({
      taxDocumentsEnabled: false,
      hasTaxDocuments: false,
    })
  })
})

/**
 * A paying workspace with every tax state on its stubbed invoice rows.
 * @returns The workspace, its owner, the rows and the documents issued.
 */
async function everyState() {
  const { tenant, owner } = await workspace()
  await makePaying(tenant.id)
  const paidPayment = `pay_${randomUUID().slice(0, 12)}`
  const invoice = await invoiced(tenant.id, charge(paidPayment))
  const note = await credited(tenant.id, invoice.id, 20_000)
  await hold(tenant.id, 'pay_HELD')
  await hold(tenant.id, 'pay_RESOLVED', true)
  const rows = [
    row('inv_ISSUED', {
      status: 'paid',
      paymentId: paidPayment,
      paidAt: '2026-10-26T05:00:00.000Z',
    }),
    row('inv_HELD', {
      status: 'paid',
      paymentId: 'pay_HELD',
      paidAt: '2026-10-26T05:00:00.000Z',
    }),
    row('inv_RESOLVED', {
      status: 'paid',
      paymentId: 'pay_RESOLVED',
      paidAt: '2026-10-26T05:00:00.000Z',
    }),
    row('inv_AT_CUTOFF', {
      status: 'paid',
      paymentId: 'pay_AT_CUTOFF',
      paidAt: EFFECTIVE_FROM.toISOString(),
    }),
    row('inv_BEFORE', {
      status: 'paid',
      paymentId: 'pay_BEFORE',
      paidAt: new Date(EFFECTIVE_FROM.getTime() - 1000).toISOString(),
    }),
    row('inv_UNPAID', { status: 'issued', paymentId: null, paidAt: null }),
  ]
  return { tenant, owner, rows, invoice, note }
}

/**
 * The tax fields of each row, by invoice id.
 * @param items - The list's items.
 * @returns The fields.
 */
function taxFields(items: Record<string, unknown>[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    items.map((item): [string, Record<string, unknown>] => [
      String(item.id),
      { taxDocument: item.taxDocument, creditNotes: item.creditNotes, taxStatus: item.taxStatus },
    ])
  )
}

describe('invoice rows', () => {
  it('links each owner row to its invoice and credit notes and gives its tax status', async () => {
    const { tenant, owner, rows, invoice, note } = await everyState()
    gst.effectiveFrom = EFFECTIVE_FROM
    let response: Awaited<ReturnType<typeof getAs>> | undefined

    await withInvoiceRows(rows, async () => {
      response = await getAs(owner, `${tenant.slug}/billing/invoices`)
    })

    expect(response?.status).toBe(200)
    const items = itemsOf(response?.body)
    expect(taxFields(items)).toStrictEqual({
      inv_ISSUED: {
        taxDocument: { id: invoice.id, number: invoice.number },
        creditNotes: [{ id: note.id, number: note.number }],
        taxStatus: 'issued',
      },
      inv_HELD: { taxDocument: null, creditNotes: [], taxStatus: 'held' },
      inv_RESOLVED: { taxDocument: null, creditNotes: [], taxStatus: 'held' },
      inv_AT_CUTOFF: { taxDocument: null, creditNotes: [], taxStatus: 'pending' },
      inv_BEFORE: { taxDocument: null, creditNotes: [], taxStatus: 'not_applicable' },
      inv_UNPAID: { taxDocument: null, creditNotes: [], taxStatus: 'not_applicable' },
    })
    for (const item of items) {
      expect(Object.keys(item).toSorted()).toStrictEqual([
        'amountMinor',
        'creditNotes',
        'currency',
        'id',
        'issuedAt',
        'paidAt',
        'status',
        'taxDocument',
        'taxStatus',
        'url',
      ])
    }
    expect(JSON.stringify(response?.body)).not.toContain('pay_')
  })

  it('gives staff the same links and status, with no payment id', async () => {
    const { tenant, rows, invoice } = await everyState()
    const { token } = await createTrackedStaff('viewer')
    let response: Awaited<ReturnType<typeof getAs>> | undefined

    await withInvoiceRows(rows, async () => {
      response = await request(app)
        .get(`/api/v1/platform/tenants/${tenant.id}/billing/invoices`)
        .set('Authorization', `Bearer ${token}`)
    })

    expect(response?.status).toBe(200)
    const items = itemsOf(response?.body)
    expect(items.map((item) => item.taxStatus)).toStrictEqual([
      'issued',
      'held',
      'held',
      'pending',
      'not_applicable',
      'not_applicable',
    ])
    expect(items[0]).toMatchObject({ taxDocument: { id: invoice.id, number: invoice.number } })
    for (const item of items) {
      expect(item).not.toHaveProperty('paymentId')
      expect(item).not.toHaveProperty('taxHeld')
      expect(item).not.toHaveProperty('url')
    }
  })

  it('reads every row as not applicable with no links while registration is off and nothing was issued', async () => {
    const { tenant, owner } = await workspace()
    await makePaying(tenant.id)
    gst.on = false

    const response = await getAs(owner, `${tenant.slug}/billing/invoices`)

    expect(response.status).toBe(200)
    const items = itemsOf(response.body)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      status: 'paid',
      taxDocument: null,
      creditNotes: [],
      taxStatus: 'not_applicable',
    })
  })
})
