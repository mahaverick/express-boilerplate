/**
 * @file TaxRepository against the real per-worker database: gap-free number
 * allocation, versioned details writes, credit sums and the page references.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql, withTransaction } from '@/services/database.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backendPid, deferred, waitForWaiter } from '../../helpers/lock-probe'
import { allocateBehindLockHolder, resetTaxDocuments, taxDocumentRow } from '../../helpers/tax'

const repository = new TaxRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()
const scope = { kind: 'razorpay', mode: 'test' } as const

/**
 * A time in the credit notes' day, `seconds` after midnight UTC.
 */
function secondsAfter(seconds: number): Date {
  return new Date(Date.UTC(2026, 9, 2, 0, 0, seconds))
}

/**
 * Inserts an invoice and returns it.
 */
async function invoice(tenantId: string, paymentId = `pay_${randomUUID().slice(0, 12)}`) {
  return withTransaction(async (tx) => {
    const number = await repository.allocateNumber('invoice', '26-27', tx)
    return repository.insertDocument(
      taxDocumentRow(tenantId, {
        number: `INV/26-27/${String(number).padStart(5, '0')}`,
        paymentId,
      }),
      tx
    )
  })
}

/**
 * Inserts a credit note against an invoice, `at` seconds after the epoch of its series.
 */
async function creditNote(
  tenantId: string,
  original: string,
  totalMinor: number,
  at: number,
  isManual = false
) {
  return withTransaction(async (tx) => {
    const number = await repository.allocateNumber('credit_note', '26-27', tx)
    return repository.insertDocument(
      taxDocumentRow(tenantId, {
        type: 'credit_note',
        number: `CN/26-27/${String(number).padStart(5, '0')}`,
        paymentId: null,
        refundId: isManual ? null : `rfnd_${randomUUID().slice(0, 12)}`,
        originalDocumentId: original,
        totalMinor,
        taxableMinor: totalMinor,
        cgstMinor: 0,
        sgstMinor: 0,
        issuedAt: secondsAfter(at),
      }),
      tx
    )
  })
}

describe('TaxRepository', () => {
  const tenantIds: string[] = []
  const userIds: string[] = []

  beforeEach(resetTaxDocuments)
  afterEach(async () => {
    await resetTaxDocuments()
    await truncateAuditLogs()
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    tenantIds.length = 0
    userIds.length = 0
  })

  /**
   * Creates a user, tracked for cleanup.
   */
  async function user(): Promise<string> {
    const created = await userRepository.create({ email: `tax-repo-${randomUUID()}@example.test` })
    userIds.push(created.id)
    return created.id
  }

  /**
   * Creates a tenant, tracked for cleanup.
   */
  async function tenant(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const created = await tenantRepository.createWithoutOwner({
      name: `Tax ${suffix}`,
      slug: `tax-${suffix}`,
    })
    tenantIds.push(created.id)
    return created.id
  }

  it('locks an invoice only for its own workspace', async () => {
    const owner = await tenant()
    const other = await tenant()
    const document = await invoice(owner)

    await withTransaction(async (tx) => {
      expect(await repository.lockInvoice(other, document.id, tx)).toBeUndefined()
      // The foreign call took no lock: another connection locks the row without waiting.
      const free =
        await sql`select id from tax_documents where id = ${document.id} for no key update nowait`
      expect(free).toHaveLength(1)
    })
    await withTransaction(async (tx) => {
      expect(await repository.lockInvoice(owner, document.id, tx)).toMatchObject({
        id: document.id,
      })
    })
  })

  it('waits at the counter row lock and numbers after the holder', async () => {
    const result = await allocateBehindLockHolder((tx) =>
      repository.allocateNumber('invoice', '26-27', tx)
    )
    expect(result).toStrictEqual({ queued: true, holderNumber: 2, allocatedNumber: 3 })
  })

  it('numbers two real allocators that overlap one after the other', async () => {
    const holding = deferred()
    const release = deferred()
    let holderPid = 0
    const first = withTransaction(async (tx) => {
      holderPid = await backendPid(tx)
      const n = await repository.allocateNumber('invoice', '26-27', tx)
      holding.resolve()
      await release.promise
      return n
    })
    await holding.promise
    const second = withTransaction((tx) => repository.allocateNumber('invoice', '26-27', tx))

    const queued = await waitForWaiter(holderPid, second)
    release.resolve()

    expect(queued).toBe(true)
    expect(await Promise.all([first, second])).toStrictEqual([1, 2])
  })

  it('leaves no gap when an allocating transaction rolls back', async () => {
    await expect(
      withTransaction(async (tx) => {
        expect(await repository.allocateNumber('invoice', '26-27', tx)).toBe(1)
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')
    expect(await withTransaction((tx) => repository.allocateNumber('invoice', '26-27', tx))).toBe(1)
    expect(
      await withTransaction((tx) => repository.allocateNumber('credit_note', '26-27', tx))
    ).toBe(1)
    expect(await withTransaction((tx) => repository.allocateNumber('invoice', '27-28', tx))).toBe(1)
  })

  it('writes details versioned and refuses a stale version', async () => {
    const tenantId = await tenant()
    const userId = await user()
    const editorId = await user()
    const inserted = await withTransaction((tx) =>
      repository.insertDetails(
        { tenantId, legalName: 'Acme', stateCode: '29', updatedBy: userId },
        tx
      )
    )
    expect(inserted.version).toBe(1)
    await expect(
      withTransaction((tx) =>
        repository.insertDetails(
          { tenantId, legalName: 'Again', stateCode: '29', updatedBy: userId },
          tx
        )
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'TAX_DETAILS_VERSION_CONFLICT' })
    const updated = await withTransaction((tx) =>
      repository.updateDetailsVersioned(tenantId, 1, { city: 'Bengaluru' }, editorId, tx)
    )
    expect(updated).toMatchObject({
      version: 2,
      city: 'Bengaluru',
      legalName: 'Acme',
      updatedBy: editorId,
    })
    const stale = await withTransaction((tx) =>
      repository.updateDetailsVersioned(tenantId, 1, { city: 'Pune' }, editorId, tx)
    )
    expect(stale).toBeUndefined()
    const found1 = await repository.findDetails(tenantId)
    expect(found1?.city).toBe('Bengaluru')
    const locked = await withTransaction((tx) => repository.lockDetails(tenantId, tx))
    expect(locked?.version).toBe(2)
  })

  it('finds invoices and credit notes by their provider ids and scopes them by tenant', async () => {
    const tenantId = await tenant()
    const document = await invoice(tenantId, 'pay_a')
    const found2 = await repository.findInvoiceByPayment(scope, 'pay_a')
    expect(found2?.id).toBe(document.id)
    expect(
      await repository.findInvoiceByPayment({ kind: 'razorpay', mode: 'live' }, 'pay_a')
    ).toBeUndefined()
    const note = await creditNote(tenantId, document.id, 500, 1)
    const found3 = await repository.findCreditNoteByRefund(scope, note.refundId!)
    expect(found3?.id).toBe(note.id)
    const found4 = await repository.findDocument(tenantId, document.id)
    expect(found4?.id).toBe(document.id)
    expect(await repository.findDocument(randomUUID(), document.id)).toBeUndefined()
    expect(await repository.hasDocuments(tenantId)).toBe(true)
    expect(await repository.hasDocuments(randomUUID())).toBe(false)
    expect(await repository.findTenantIdForPayment(scope, 'pay_a')).toBe(tenantId)
  })

  it('sums manual and automatic notes in creditedBefore and listInvoicesByPayments', async () => {
    const tenantId = await tenant()
    const document = await invoice(tenantId, 'pay_b')
    await creditNote(tenantId, document.id, 1180, 1, true)
    await creditNote(tenantId, document.id, 2000, 2)
    expect(await withTransaction((tx) => repository.creditedBefore(document.id, tx))).toBe(3180)
    const [listed] = await repository.listInvoicesByPayments(scope, ['pay_b', 'pay_none'])
    expect(listed).toMatchObject({ id: document.id, creditedMinor: 3180 })
    expect(await repository.listInvoicesByPayments(scope, [])).toStrictEqual([])
  })

  it('holds a charge once and finds its tenant', async () => {
    const tenantId = await tenant()
    const row = {
      tenantId,
      provider: 'razorpay',
      providerMode: 'test',
      paymentId: 'pay_held',
      amountMinor: 11_800,
      paidAt: new Date('2026-10-01T00:00:00.000Z'),
    } as const
    expect(await withTransaction((tx) => repository.insertHeld(row, tx))).toBeDefined()
    expect(await withTransaction((tx) => repository.insertHeld(row, tx))).toBeUndefined()
    const found5 = await repository.findHeldByPayment(scope, 'pay_held')
    expect(found5?.tenantId).toBe(tenantId)
    expect(await repository.findTenantIdForPayment(scope, 'pay_held')).toBe(tenantId)
    expect(await repository.findTenantIdForPayment(scope, 'pay_nobody')).toBeUndefined()
  })

  it('maps a payment to its invoice and two notes, oldest first', async () => {
    const tenantId = await tenant()
    const document = await invoice(tenantId, 'pay_c')
    const second = await creditNote(tenantId, document.id, 700, 20)
    const first = await creditNote(tenantId, document.id, 600, 10)
    await withTransaction((tx) =>
      repository.insertHeld(
        {
          tenantId,
          provider: 'razorpay',
          providerMode: 'test',
          paymentId: 'pay_h',
          amountMinor: 100,
          paidAt: new Date(),
        },
        tx
      )
    )
    const rows = await repository.listForInvoiceRows(tenantId, scope, ['pay_c', 'pay_h', 'pay_x'])
    expect(rows.get('pay_c')).toStrictEqual({
      taxDocument: { id: document.id, number: document.number },
      creditNotes: [
        { id: first.id, number: first.number },
        { id: second.id, number: second.number },
      ],
      held: false,
    })
    expect(rows.get('pay_h')).toStrictEqual({ taxDocument: null, creditNotes: [], held: true })
    expect(rows.has('pay_x')).toBe(false)
    const found6 = await repository.listForInvoiceRows(randomUUID(), scope, ['pay_c'])
    expect(found6.size).toBe(0)
  })

  it('builds a page of references in one pass', async () => {
    const tenantId = await tenant()
    const document = await invoice(tenantId)
    const other = await invoice(tenantId)
    const second = await creditNote(tenantId, document.id, 700, 20)
    const first = await creditNote(tenantId, document.id, 600, 10)
    const references = await repository.listRefsFor([document, other, second])
    expect(references.creditNotes.get(document.id)).toStrictEqual([
      { id: first.id, number: first.number },
      { id: second.id, number: second.number },
    ])
    expect(references.creditNotes.get(other.id)).toStrictEqual([])
    expect(references.credited.get(document.id)).toBe(1300)
    expect(references.credited.get(other.id)).toBe(0)
    expect(references.originals.get(second.id)).toStrictEqual({
      id: document.id,
      number: document.number,
    })
    const found7 = await repository.listRefsFor([])
    expect(found7.originals.size).toBe(0)
  })
})
