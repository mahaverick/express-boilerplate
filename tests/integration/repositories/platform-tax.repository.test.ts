/**
 * @file PlatformTaxRepository against the real per-worker database: the
 * staff lists, the held-charge resolve and the export read.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import type { NewTaxDocument } from '@/database/models/tax.model'
import {
  heldChargeList,
  PlatformTaxRepository,
  staffTaxDocumentList,
} from '@/repositories/platform-tax.repository'
import { TaxRepository } from '@/repositories/tax.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql, withTransaction } from '@/services/database.service'
import { listPage, listPageQuery, type ListParams } from '@/utilities/list-page.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetTaxDocuments, taxDocumentRow } from '../../helpers/tax'

const repository = new PlatformTaxRepository()
const taxRepository = new TaxRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

/**
 * First-page params for a sort.
 */
function params(sort: string, search?: string): ListParams {
  return {
    search,
    sort,
    cursor: undefined,
    direction: 'next',
    limit: 20,
    total: false,
    scope: 'test',
  }
}

/**
 * Inserts a document with the given number and time.
 */
async function document(
  tenantId: string | null,
  number: string,
  issuedAt: Date,
  extra: Partial<NewTaxDocument> = {}
) {
  return withTransaction((tx) =>
    taxRepository.insertDocument(taxDocumentRow(tenantId, { number, issuedAt, ...extra }), tx)
  )
}

/**
 * Holds a charge.
 */
async function held(tenantId: string, paymentId: string, heldAt: Date) {
  const row = await withTransaction((tx) =>
    taxRepository.insertHeld(
      {
        tenantId,
        provider: 'razorpay',
        providerMode: 'test',
        paymentId,
        amountMinor: 100,
        paidAt: new Date('2026-09-30T00:00:00Z'),
        heldAt,
      },
      tx
    )
  )
  if (row === undefined) throw new Error('setup: the payment was already held')
  return row.id
}

describe('PlatformTaxRepository', () => {
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
   * Creates a tenant, tracked for cleanup.
   */
  async function tenant(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const created = await tenantRepository.createWithoutOwner({
      name: `PTax ${suffix}`,
      slug: `ptax-${suffix}`,
    })
    tenantIds.push(created.id)
    return created.id
  }

  it('searches a number as a literal, case-insensitively', async () => {
    const tenantId = await tenant()
    await document(tenantId, 'INV/26-27/00001', new Date('2026-10-01T00:00:00Z'))
    await document(tenantId, 'INV/26-27/00002', new Date('2026-10-02T00:00:00Z'))
    const base = await document(tenantId, 'X', new Date('2026-10-04T00:00:00Z'))
    await document(tenantId, 'CN/27-28/00001', new Date('2026-10-03T00:00:00Z'), {
      type: 'credit_note',
      paymentId: null,
      originalDocumentId: base.id,
      financialYear: '27-28',
    })
    /**
     * One page of the staff list.
     */
    const list = (search?: string, types?: ('invoice' | 'credit_note')[]) =>
      listPage(db, staffTaxDocumentList(tenantId, search, { types }), params('-issued', search))
    const literal = await list('26-27/0000')
    expect(literal.items.map((index) => index.document.number)).toStrictEqual([
      'INV/26-27/00002',
      'INV/26-27/00001',
    ])
    const found1 = await list('inv/26')
    expect(found1.items).toHaveLength(2)
    const found2 = await list('%')
    expect(found2.items).toHaveLength(0)
    const found3 = await list('_')
    expect(found3.items).toHaveLength(0)
    const found4 = await list(undefined, ['credit_note'])
    expect(found4.items).toHaveLength(1)
  })

  it('lists held charges newest first, filters by status and refuses another sort', async () => {
    const tenantId = await tenant()
    const user = await userRepository.create({ email: `ptax-${randomUUID()}@example.test` })
    userIds.push(user.id)
    const older = await held(tenantId, 'pay_1', new Date('2026-10-01T00:00:00Z'))
    const newer = await held(tenantId, 'pay_2', new Date('2026-10-02T00:00:00Z'))
    await withTransaction((tx) =>
      repository.resolveHeld(tenantId, older, user.id, 'Issued by hand', tx)
    )
    /**
     * One page of the held list.
     */
    const run = (statuses?: ('open' | 'resolved')[]) =>
      listPage(db, heldChargeList(tenantId, statuses), params('-heldAt'))
    const all = await run()
    expect(all.items.map((index) => index.charge.id)).toStrictEqual([newer, older])
    const open = await run(['open'])
    expect(open.items.map((index) => index.charge.id)).toStrictEqual([newer])
    const resolvedPage = await run(['resolved'])
    const resolved = resolvedPage.items
    expect(resolved.map((index) => index.charge.id)).toStrictEqual([older])
    expect(resolved[0]?.resolvedBy?.userId).toBe(user.id)
    const found5 = await run(['open', 'resolved'])
    expect(found5.items).toHaveLength(2)
    expect(() => listPageQuery(db, heldChargeList(tenantId, undefined), params('heldAt'))).toThrow(
      'not whitelisted'
    )
    expect(() =>
      listPageQuery(db, heldChargeList(tenantId, undefined), params('-created'))
    ).toThrow()
  })

  it('resolves a held charge once', async () => {
    const tenantId = await tenant()
    const user = await userRepository.create({ email: `ptax-${randomUUID()}@example.test` })
    userIds.push(user.id)
    const id = await held(tenantId, 'pay_r', new Date())
    expect(await repository.countOpenHeld(tenantId)).toBe(1)
    const first = await withTransaction((tx) =>
      repository.resolveHeld(tenantId, id, user.id, 'Done', tx)
    )
    expect(first).toMatchObject({ id, resolvedBy: user.id, resolution: 'Done' })
    expect(first?.resolvedAt).toBeInstanceOf(Date)
    expect(
      await withTransaction((tx) => repository.resolveHeld(tenantId, id, user.id, 'Again', tx))
    ).toBeUndefined()
    expect(
      await withTransaction((tx) => repository.resolveHeld(randomUUID(), id, user.id, 'x', tx))
    ).toBeUndefined()
    expect(await repository.countOpenHeld(tenantId)).toBe(0)
    expect(await repository.hasHeld(tenantId)).toBe(true)
    expect(await repository.hasHeld(randomUUID())).toBe(false)
    const found6 = await repository.findHeld(tenantId, id)
    expect(found6?.resolvedBy?.userId).toBe(user.id)
    expect(await repository.findHeld(randomUUID(), id)).toBeUndefined()
  })

  it('sees documents of a purged tenant in hasAnyDocuments', async () => {
    expect(await repository.hasAnyDocuments()).toBe(false)
    await document(null, 'INV/26-27/00009', new Date())
    expect(await repository.hasAnyDocuments()).toBe(true)
  })

  it('exports a half-open range ordered by type, time and id, with the invoice joined to notes', async () => {
    const tenantId = await tenant()
    const from = new Date('2026-10-01T00:00:00Z')
    const to = new Date('2026-11-01T00:00:00Z')
    await document(tenantId, 'INV/26-27/00001', new Date('2026-09-30T23:59:59.999Z'))
    const inFirst = await document(tenantId, 'INV/26-27/00002', from, {
      buyerGstin: '29ABCDE1234F1ZW',
    })
    await document(tenantId, 'INV/26-27/00003', to)
    const note = await document(tenantId, 'CN/26-27/00001', new Date('2026-10-15T00:00:00Z'), {
      type: 'credit_note',
      paymentId: null,
      originalDocumentId: inFirst.id,
    })
    const rows = await repository.listDocumentsIssuedBetween(from, to)
    expect(rows.map((r) => r.number)).toStrictEqual(['CN/26-27/00001', 'INV/26-27/00002'])
    expect(rows[0]?.id).toBe(note.id)
    expect(rows[0]?.original).toStrictEqual({
      number: 'INV/26-27/00002',
      issuedAt: from,
      buyerGstin: '29ABCDE1234F1ZW',
    })
    expect(rows[1]?.original).toBeNull()
  })
})
