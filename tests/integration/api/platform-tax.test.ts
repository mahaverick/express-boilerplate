/**
 * @file Staff tax routes end to end against the real database and the fake
 * payment provider: a workspace's tax details read and staff save, its
 * document list and PDFs, the admin's manual credit note, the held SEZ
 * charges and their resolve, the open held count on the staff billing read,
 * the tax fields of the billing settings, and the refusals (the platform
 * tenant, registration off, a role lowered mid-request). Registration and
 * the configured effective date are switched per test through the mocked
 * billing config.
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
import type { TaxDocumentRecord } from '@/database/models/tax.model'
import { NOT_FOUND } from '@/errors/not-found-errors'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { issueInvoice } from '@/services/billing/tax-documents.service'
import { sql, withTransaction } from '@/services/database.service'
import { closeQueue, getEmailQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import type { ProviderCharge, ProviderInvoice } from '@/types/billing'
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
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedStaff, deleteTrackedUsers } from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { resetTaxDocuments } from '../../helpers/tax'

/**
 * Whether GST registration is on, and the configured effective date; the
 * hooks reset both.
 */
const gst = vi.hoisted(() => ({ on: true, effectiveFrom: '2026-04-01' as string | null }))

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => (gst.on ? seller : null),
    gstEffectiveFromSetting: () => gst.effectiveFrom,
  }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const app = createApp()
const taxRepository = new TaxRepository()
const scope = { kind: 'fake', mode: 'test' } as const
const REASON = 'Lost the dispute on this charge.'
const ANY_STRING = expect.any(String) as unknown as string
const READ_DISABLED = 'Tax documents are off, and this workspace has none to download.'
const WRITE_DISABLED =
  "Tax documents are off, so tax details and credit notes can't change. Issued documents stay available to download."

beforeAll(async () => {
  await loadPlans()
})

beforeEach(async () => {
  gst.on = true
  gst.effectiveFrom = '2026-04-01'
  await resetTaxDocuments()
})

afterEach(async () => {
  gst.on = true
  gst.effectiveFrom = '2026-04-01'
  await resetTaxDocuments()
  await getEmailQueue().obliterate({ force: true })
  await sql`delete from billing_alerts where kind = 'tax_credit_note_late'`
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
 * A staff member of `role` with a token that passes the step-up check.
 * @param role - The platform role.
 * @returns The user and the token.
 */
function staff(role: 'viewer' | 'manager' | 'admin') {
  return createTrackedStaff(role, { firstName: 'Ria' })
}

/**
 * GET a staff billing path.
 * @param token - The bearer token.
 * @param path - The path after `/api/v1/platform`.
 * @returns The response.
 */
function getAs(token: string, path: string) {
  return request(app).get(`/api/v1/platform${path}`).set('Authorization', `Bearer ${token}`)
}

/**
 * Send a JSON write to a staff path.
 * @param method - The method.
 * @param token - The bearer token.
 * @param path - The path after `/api/v1/platform`.
 * @param body - The JSON body.
 * @returns The response.
 */
function sendAs(method: 'post' | 'patch', token: string, path: string, body: object) {
  return request(app)
    [method](`/api/v1/platform${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send(body)
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
 * Issue an invoice for a ₹999 charge and fail unless it was issued.
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
 * Hold a payment as an SEZ charge.
 * @param tenantId - The workspace.
 * @param paymentId - The payment.
 * @param heldAt - When it was held.
 * @returns The held charge's id.
 */
async function hold(
  tenantId: string,
  paymentId = `pay_${randomUUID().slice(0, 12)}`,
  heldAt = new Date('2026-10-26T06:00:00.000Z')
): Promise<string> {
  const row = await withTransaction((tx) =>
    taxRepository.insertHeld(
      {
        tenantId,
        provider: scope.kind,
        providerMode: scope.mode,
        paymentId,
        subscriptionId: 'sub_SEZ',
        amountMinor: 99_900,
        paidAt: new Date('2026-10-26T05:00:00.000Z'),
        heldAt,
      },
      tx
    )
  )
  if (row === undefined) throw new Error('setup: the hold was not stored')
  return row.id
}

/**
 * The audit entries of one action, oldest first.
 * @param action - The action.
 * @returns Their access, target and metadata.
 */
async function auditOf(action: string) {
  const rows = await sql<
    { access: string; targetType: string; targetId: string; metadata: unknown }[]
  >`
    select access, target_type as "targetType", target_id as "targetId", metadata
    from audit_logs where action = ${action} order by occurred_at, id`
  // A plain array: the driver's result carries its own fields, which a strict comparison sees.
  return [...rows]
}

/**
 * Save a workspace's tax details as the owner would have.
 * @param tenantId - The workspace.
 * @param userId - Who saved them.
 */
async function storeDetails(tenantId: string, userId: string): Promise<void> {
  await withTransaction((tx) =>
    taxRepository.insertDetails(
      {
        tenantId,
        gstin: '29ABCDE1234F1ZW',
        legalName: 'Billing Co Pvt Ltd',
        addressLine1: '1 Residency Road',
        addressLine2: null,
        city: 'Bengaluru',
        pincode: '560025',
        stateCode: '29',
        isSez: false,
        updatedBy: userId,
      },
      tx
    )
  )
}

/**
 * GET a document's PDF with the body read as bytes.
 * @param token - The bearer token.
 * @param tenantId - The workspace.
 * @param id - The document id.
 * @returns The response; `body` is a Buffer on success.
 */
function pdfAs(token: string, tenantId: string, id: string) {
  return getAs(token, `/tenants/${tenantId}/billing/tax-documents/${id}/pdf`)
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        done(null, Buffer.concat(chunks))
      })
    })
}

describe('staff tax details', () => {
  it('lets a viewer read the details with who saved them last', async () => {
    const { tenant, owner } = await workspace({ firstName: 'Ada' })
    await storeDetails(tenant.id, owner.id)
    const { token } = await staff('viewer')

    const response = await getAs(token, `/tenants/${tenant.id}/billing/tax-details`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({
      gstin: '29ABCDE1234F1ZW',
      state: { code: '29', name: 'Karnataka' },
      version: 1,
      updatedBy: { userId: owner.id, name: 'Ada' },
    })
  })

  it('answers null before the first save', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('viewer')

    const response = await getAs(token, `/tenants/${tenant.id}/billing/tax-details`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toBeNull()
  })

  it('lets a manager save a change with a reason, naming the workspace, and audits the field names', async () => {
    const { tenant, owner } = await workspace()
    await storeDetails(tenant.id, owner.id)
    const { user, token } = await staff('manager')

    const response = await sendAs('patch', token, `/tenants/${tenant.id}/billing/tax-details`, {
      version: 1,
      pincode: '560001',
      reason: REASON,
    })

    expect(response.status).toBe(200)
    expect((response.body as { message: string }).message).toBe(
      'Tax details for Billing Co saved. They apply to invoices issued from now on.'
    )
    expect(dataOf(response.body)).toMatchObject({
      pincode: '560001',
      version: 2,
      updatedBy: { userId: user.id, name: 'Ria' },
    })
    expect(await auditOf('billing.tax_details_updated')).toStrictEqual([
      {
        access: 'platform',
        targetType: 'billing',
        targetId: tenant.id,
        metadata: { changedFields: ['pincode'], reason: REASON },
      },
    ])
  })

  it('runs the owner rules on a staff save', async () => {
    const { tenant, owner } = await workspace()
    await storeDetails(tenant.id, owner.id)
    const { token } = await staff('manager')

    const response = await sendAs('patch', token, `/tenants/${tenant.id}/billing/tax-details`, {
      version: 1,
      stateCode: '27',
      reason: REASON,
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      errors: {
        stateCode: ['This GSTIN is registered in Karnataka. Choose Karnataka as the state.'],
      },
    })
  })

  it('needs a reason', async () => {
    const { tenant, owner } = await workspace()
    await storeDetails(tenant.id, owner.id)
    const { token } = await staff('manager')

    const response = await sendAs('patch', token, `/tenants/${tenant.id}/billing/tax-details`, {
      version: 1,
      pincode: '560001',
    })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { reason: [ANY_STRING] } })
  })
})

describe('staff tax documents', () => {
  it('lets a viewer list the documents with the manual flag and search the number', async () => {
    const { tenant } = await workspace()
    const first = await invoiced(tenant.id, charge(), new Date('2026-10-20T06:30:00.000Z'))
    await invoiced(tenant.id, charge(), new Date('2026-10-27T06:30:00.000Z'))
    const { token } = await staff('viewer')

    const all = await getAs(token, `/tenants/${tenant.id}/billing/tax-documents?total=1`)
    const found = await getAs(token, `/tenants/${tenant.id}/billing/tax-documents?search=00001`)
    const oldest = await getAs(token, `/tenants/${tenant.id}/billing/tax-documents?sort=issued`)

    expect(all.status).toBe(200)
    expect(itemsOf(all.body).map((item) => item.number)).toStrictEqual([
      'INV/26-27/00002',
      'INV/26-27/00001',
    ])
    expect(itemsOf(all.body)[1]).toMatchObject({
      id: first.id,
      type: 'invoice',
      manual: false,
      createdBy: null,
      paymentId: first.paymentId,
    })
    expect((all.body as { data: { total: unknown } }).data.total).toStrictEqual({
      count: 2,
      capped: false,
    })
    expect(itemsOf(found.body).map((item) => item.number)).toStrictEqual(['INV/26-27/00001'])
    const anyCase = await getAs(
      token,
      `/tenants/${tenant.id}/billing/tax-documents?search=inv/26-27/00002`
    )
    expect(itemsOf(anyCase.body).map((item) => item.number)).toStrictEqual(['INV/26-27/00002'])
    expect(itemsOf(oldest.body).map((item) => item.number)).toStrictEqual([
      'INV/26-27/00001',
      'INV/26-27/00002',
    ])
  })

  it('lets a viewer download a PDF', async () => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const { token } = await staff('viewer')

    const response = await pdfAs(token, tenant.id, invoice.id)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="INV-26-27-00001.pdf"'
    )
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await auditOf('billing.viewed')).toHaveLength(1)
  })

  it('answers another workspace document 404 tax_document_not_found', async () => {
    const { tenant } = await workspace()
    const { tenant: other } = await workspace()
    const invoice = await invoiced(other.id)
    const { token } = await staff('viewer')

    const response = await pdfAs(token, tenant.id, invoice.id)

    expect(response.status).toBe(404)
  })
})

describe('the manual credit note', () => {
  it('issues a note against an invoice, then refuses more than is left, then refuses a note on a note', async () => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const { user, token } = await staff('admin')
    const path = `/tenants/${tenant.id}/billing/tax-documents`

    const issued = await sendAs('post', token, `${path}/${invoice.id}/credit-notes`, {
      amountMinor: 20_000,
      reason: REASON,
    })
    const tooMuch = await sendAs('post', token, `${path}/${invoice.id}/credit-notes`, {
      amountMinor: 80_000,
      reason: REASON,
    })
    const noteId = dataOf(issued.body).id as string
    const onNote = await sendAs('post', token, `${path}/${noteId}/credit-notes`, {
      amountMinor: 1000,
      reason: REASON,
    })

    expect(issued.status).toBe(200)
    expect((issued.body as { message: string }).message).toBe(
      'Credit note CN/26-27/00001 issued for ₹200.'
    )
    expect(dataOf(issued.body)).toMatchObject({
      type: 'credit_note',
      number: 'CN/26-27/00001',
      invoice: { id: invoice.id, number: invoice.number },
      amounts: { totalMinor: 20_000 },
      reason: REASON,
      refundId: null,
      manual: true,
      createdBy: { userId: user.id, name: 'Ria' },
    })
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.body).toMatchObject({
      code: 'CREDIT_EXCEEDS_INVOICE',
      message: 'This invoice has ₹799 left to credit. Enter ₹799 or less.',
      details: { remainingMinor: 79_900 },
    })
    expect(onNote.status).toBe(409)
    expect(onNote.body).toMatchObject({
      code: 'NOT_AN_INVOICE',
      message: 'Credit notes reduce invoices only. Pick the invoice instead.',
    })
    expect(await auditOf('billing.credit_note_issued_by_staff')).toStrictEqual([
      {
        access: 'platform',
        targetType: 'tax_document',
        targetId: noteId,
        metadata: { invoiceId: invoice.id, reason: REASON },
      },
    ])
    const search = await getAs(token, `${path}?search=00001&type=credit_note`)
    expect(itemsOf(search.body).map((item) => item.number)).toStrictEqual(['CN/26-27/00001'])
  })

  it('mails the owner a link to the note once it commits, and mails nothing for a refused note', async () => {
    const { tenant, owner } = await workspace()
    const invoice = await invoiced(tenant.id)
    const { token } = await staff('admin')
    const path = `/tenants/${tenant.id}/billing/tax-documents/${invoice.id}/credit-notes`
    /**
     * The workspace's tax document mails.
     * @returns Each mail's recipient and stored variables.
     */
    const mails = () => sql<{ recipient: string; variables: Record<string, string> }[]>`
      select recipient, variables from email_messages
      where tenant_id = ${tenant.id} and template_key = 'tax_document_issued'`

    const tooMuch = await sendAs('post', token, path, { amountMinor: 150_000, reason: REASON })
    const refused = await mails()
    await sendAs('post', token, path, { amountMinor: 20_000, reason: REASON })
    const sent = await mails()

    expect(tooMuch.status).toBe(409)
    expect(refused).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.recipient).toBe(owner.email)
    expect(sent[0]?.variables).toMatchObject({
      documentType: 'credit_note',
      documentNumber: 'CN/26-27/00001',
      invoiceNumber: invoice.number,
    })
  })

  it.each([0, 99, 1.5, '20000'])('refuses an amount of %s', async (amountMinor) => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const { token } = await staff('admin')

    const response = await sendAs(
      'post',
      token,
      `/tenants/${tenant.id}/billing/tax-documents/${invoice.id}/credit-notes`,
      { amountMinor, reason: REASON }
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { amountMinor: [ANY_STRING] } })
  })

  it('answers an unknown invoice 404 tax_document_not_found', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('admin')

    const response = await sendAs(
      'post',
      token,
      `/tenants/${tenant.id}/billing/tax-documents/${randomUUID()}/credit-notes`,
      { amountMinor: 1000, reason: REASON }
    )

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'tax_document_not_found' })
  })

  it('refuses an admin lowered to manager after the gate, and writes nothing', async () => {
    const { tenant } = await workspace()
    const invoice = await invoiced(tenant.id)
    const { user, token } = await staff('admin')
    const platform = await platformTenant()
    const original = TenantRepository.prototype.findByIdIncludingDeleted
    let response: Awaited<ReturnType<typeof sendAs>> | undefined

    await withMutatedMethod(
      TenantRepository.prototype,
      'findByIdIncludingDeleted',
      async function (this: TenantRepository, ...parameters) {
        await sql`update user_memberships set role = 'manager'
          where user_id = ${user.id} and tenant_id = ${platform.id}`
        return original.apply(this, parameters)
      },
      async () => {
        response = await sendAs(
          'post',
          token,
          `/tenants/${tenant.id}/billing/tax-documents/${invoice.id}/credit-notes`,
          { amountMinor: 20_000, reason: REASON }
        )
      }
    )

    expect(response?.status).toBe(404)
    expect(response?.body).toMatchObject({ message: NOT_FOUND.route.message })
    const [notes] = await sql<{ count: number }[]>`
      select count(*)::int as count from tax_documents where type = 'credit_note'`
    expect(notes?.count).toBe(0)
    const [counter] = await sql<{ count: number }[]>`
      select count(*)::int as count from tax_document_counters where type = 'credit_note'`
    expect(counter?.count).toBe(0)
    expect(await auditOf('billing.credit_note_issued_by_staff')).toStrictEqual([])
  })

  it('raises one late alert for a note after 30 November following the invoice year', async () => {
    const { tenant } = await workspace()
    // An invoice of FY 24-25: a note issued today is past 30 November 2025.
    const invoice = await invoiced(tenant.id, charge(), new Date('2024-10-27T06:30:00.000Z'))
    const { token } = await staff('admin')
    const path = `/tenants/${tenant.id}/billing/tax-documents/${invoice.id}/credit-notes`

    const first = await sendAs('post', token, path, { amountMinor: 1000, reason: REASON })
    const second = await sendAs('post', token, path, { amountMinor: 1000, reason: REASON })

    expect([first.status, second.status]).toStrictEqual([200, 200])
    expect(dataOf(first.body)).toMatchObject({ noTaxReduction: true })
    const numbers = [first, second].map((response) => dataOf(response.body).number as string)
    const alerts = await sql<{ message: string }[]>`
      select message from billing_alerts
      where tenant_id = ${tenant.id} and kind = 'tax_credit_note_late' order by at, id`
    expect(alerts.map((alert) => alert.message)).toStrictEqual(
      numbers.map(
        (number) =>
          `Credit note ${number} for ${invoice.number} was issued after 30 November 2025, so it gives no tax reduction. Tell your CA.`
      )
    )
  })
})

describe('held charges', () => {
  it('lists the open hold, resolves it once, and refuses a second resolve', async () => {
    const { tenant } = await workspace()
    const heldId = await hold(tenant.id, 'pay_SEZ')
    const { user, token: adminToken } = await staff('admin')
    const { token } = await staff('viewer')
    const path = `/tenants/${tenant.id}/billing/tax-held-charges`

    const open = await getAs(token, `${path}?status=open&sort=-heldAt`)
    const resolved = await sendAs('post', adminToken, `${path}/${heldId}/resolve`, {
      reason: 'Issued INV-SEZ-1 by hand.',
    })
    const again = await sendAs('post', adminToken, `${path}/${heldId}/resolve`, {
      reason: 'Twice.',
    })
    const openAfter = await getAs(token, `${path}?status=open`)

    expect(open.status).toBe(200)
    expect(itemsOf(open.body)).toStrictEqual([
      {
        id: heldId,
        paymentId: 'pay_SEZ',
        subscriptionId: 'sub_SEZ',
        amountMinor: 99_900,
        paidAt: '2026-10-26T05:00:00.000Z',
        heldAt: '2026-10-26T06:00:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      },
    ])
    expect(resolved.status).toBe(200)
    expect((resolved.body as { message: string }).message).toBe('Held charge marked resolved.')
    expect(dataOf(resolved.body)).toMatchObject({
      id: heldId,
      resolvedAt: ANY_STRING,
      resolvedBy: { userId: user.id, name: 'Ria' },
      resolution: 'Issued INV-SEZ-1 by hand.',
    })
    expect(again.status).toBe(409)
    expect((again.body as { code: string }).code).toBe('HELD_CHARGE_RESOLVED')
    expect((again.body as { message: string }).message).toMatch(
      /^This held charge was resolved on \d{1,2} \w+ \d{4}\. Nothing changed\.$/
    )
    expect(itemsOf(openAfter.body)).toStrictEqual([])
    expect(await auditOf('billing.held_charge_resolved')).toStrictEqual([
      {
        access: 'platform',
        targetType: 'billing',
        targetId: tenant.id,
        metadata: { heldChargeId: heldId, reason: 'Issued INV-SEZ-1 by hand.' },
      },
    ])
  })

  it('takes only the -heldAt sort', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('viewer')

    const response = await getAs(
      token,
      `/tenants/${tenant.id}/billing/tax-held-charges?sort=heldAt`
    )

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ errors: { sort: [ANY_STRING] } })
  })

  it('answers an unknown held charge 404 tax_held_charge_not_found', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('admin')

    const response = await sendAs(
      'post',
      token,
      `/tenants/${tenant.id}/billing/tax-held-charges/${randomUUID()}/resolve`,
      { reason: REASON }
    )

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      code: 'tax_held_charge_not_found',
      message:
        'This workspace has no held charge with that ID. Reload the page to see its held charges.',
    })
  })

  it('counts the open holds on the staff billing read', async () => {
    const { tenant } = await workspace()
    await hold(tenant.id)
    const resolvedId = await hold(tenant.id)
    await sql`update tax_held_charges set resolved_at = now(), resolution = 'Done.' where id = ${resolvedId}`
    const { token } = await staff('viewer')

    const response = await getAs(token, `/tenants/${tenant.id}/billing`)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toMatchObject({ openHeldCharges: 1 })
  })
})

describe('refusals', () => {
  it('answers the platform tenant 404 tenant_billing_not_found on every tax route', async () => {
    const platform = await platformTenant()
    const { token } = await staff('admin')
    const base = `/tenants/${platform.id}/billing`

    const responses = [
      await getAs(token, `${base}/tax-details`),
      await sendAs('patch', token, `${base}/tax-details`, { version: null, reason: REASON }),
      await getAs(token, `${base}/tax-documents`),
      await getAs(token, `${base}/tax-documents/${randomUUID()}/pdf`),
      await sendAs('post', token, `${base}/tax-documents/${randomUUID()}/credit-notes`, {
        amountMinor: 1000,
        reason: REASON,
      }),
      await getAs(token, `${base}/tax-held-charges`),
      await sendAs('post', token, `${base}/tax-held-charges/${randomUUID()}/resolve`, {
        reason: REASON,
      }),
    ]

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ code: 'tenant_billing_not_found' })
    }
  })

  it('keeps the reads while registration is off and documents exist, and refuses the writes', async () => {
    const { tenant, owner } = await workspace()
    const invoice = await invoiced(tenant.id)
    await storeDetails(tenant.id, owner.id)
    gst.on = false
    const { token } = await staff('admin')
    const base = `/tenants/${tenant.id}/billing`

    const details = await getAs(token, `${base}/tax-details`)
    const list = await getAs(token, `${base}/tax-documents`)
    const pdf = await pdfAs(token, tenant.id, invoice.id)
    const held = await getAs(token, `${base}/tax-held-charges`)
    const note = await sendAs('post', token, `${base}/tax-documents/${invoice.id}/credit-notes`, {
      amountMinor: 1000,
      reason: REASON,
    })
    const save = await sendAs('patch', token, `${base}/tax-details`, {
      version: 1,
      pincode: '560001',
      reason: REASON,
    })

    expect([details.status, list.status, pdf.status, held.status]).toStrictEqual([
      200, 200, 200, 200,
    ])
    for (const response of [note, save]) {
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({
        code: 'tax_documents_disabled',
        message: WRITE_DISABLED,
      })
    }
  })

  it('answers 404 tax_documents_disabled while registration is off and nothing exists, but keeps a workspace with held charges', async () => {
    const { tenant } = await workspace()
    const { tenant: holding } = await workspace()
    const heldId = await hold(holding.id)
    gst.on = false
    const { token } = await staff('admin')

    const details = await getAs(token, `/tenants/${tenant.id}/billing/tax-details`)
    const held = await getAs(token, `/tenants/${tenant.id}/billing/tax-held-charges`)
    const holdingList = await getAs(token, `/tenants/${holding.id}/billing/tax-held-charges`)
    const resolve = await sendAs(
      'post',
      token,
      `/tenants/${holding.id}/billing/tax-held-charges/${heldId}/resolve`,
      { reason: REASON }
    )

    for (const response of [details, held]) {
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({
        code: 'tax_documents_disabled',
        message: READ_DISABLED,
      })
    }
    expect(holdingList.status).toBe(200)
    expect(itemsOf(holdingList.body)).toHaveLength(1)
    expect(resolve.status).toBe(200)
  })
})

describe('GET /api/v1/platform/billing-settings tax fields', () => {
  it('shows registration, whether any document exists and the effective date', async () => {
    const { tenant } = await workspace()
    const { token } = await staff('viewer')

    const before = await getAs(token, '/billing-settings')
    await invoiced(tenant.id)
    const after = await getAs(token, '/billing-settings')
    gst.on = false
    const off = await getAs(token, '/billing-settings')

    expect(dataOf(before.body)).toMatchObject({
      taxDocumentsEnabled: true,
      hasTaxDocuments: false,
      gstEffectiveFrom: '2026-04-01',
    })
    expect(dataOf(after.body)).toMatchObject({ hasTaxDocuments: true })
    expect(dataOf(off.body)).toMatchObject({
      taxDocumentsEnabled: false,
      hasTaxDocuments: true,
      gstEffectiveFrom: '2026-04-01',
    })
  })
})

describe('staff invoice rows', () => {
  it('carry the tax status', async () => {
    const { tenant } = await workspace()
    await makePaying(tenant.id)
    const paymentId = `pay_${randomUUID().slice(0, 12)}`
    const invoice = await invoiced(tenant.id, charge(paymentId))
    const { token } = await staff('viewer')
    const rows: ProviderInvoice[] = [
      {
        id: 'inv_ISSUED',
        subscriptionId: 'sub_STUB',
        amountMinor: 99_900,
        currency: 'INR',
        issuedAt: '2026-10-26T05:00:00.000Z',
        url: null,
        status: 'paid',
        paymentId,
        paidAt: '2026-10-26T05:00:00.000Z',
      },
    ]
    let response: Awaited<ReturnType<typeof getAs>> | undefined

    await withMutatedMethod(
      fake,
      'listInvoices',
      () => Promise.resolve({ items: rows, nextCursor: null }),
      async () => {
        response = await getAs(token, `/tenants/${tenant.id}/billing/invoices`)
      }
    )

    expect(response?.status).toBe(200)
    expect(itemsOf(response?.body)[0]).toMatchObject({
      taxStatus: 'issued',
      taxDocument: { id: invoice.id, number: invoice.number },
    })
  })
})
