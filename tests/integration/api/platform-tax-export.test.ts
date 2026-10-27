/**
 * @file The staff tax export end to end against the real database: an
 * admin with a recent sign-in downloads a month or a quarter of documents as
 * a zip of GSTR-1 CSVs, the IST period edges, the refusals (a malformed
 * period, a role below admin, a stale sign-in, registration off with no
 * documents), the audit entry, a purged workspace's documents and byte-equal
 * rebuilds. Registration is switched per test through the mocked billing
 * config.
 */
import { randomUUID } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import type { NewTaxDocument } from '@/database/models/tax.model'
import { NOT_FOUND } from '@/errors/not-found-errors'
import { TaxRepository } from '@/repositories/tax.repository'
import { sql, withTransaction } from '@/services/database.service'
import { closeQueue } from '@/services/queue.service'
import { closeRedis } from '@/services/redis.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackedTenants, workspace } from '../../helpers/billing-api'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  deleteTrackedUsers,
  staleAuthTokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { resetTaxDocuments, taxDocumentRow } from '../../helpers/tax'

/**
 * Whether GST registration is on; the hooks reset it.
 */
const gst = vi.hoisted(() => ({ on: true }))

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => (gst.on ? seller : null),
  }
})

const app = createApp()
const taxRepository = new TaxRepository()
const EXPORT_DISABLED =
  'Tax documents are off, and no workspace has any, so there is nothing to export.'
const PERIOD_MESSAGE = 'Use YYYY-MM for a month or YYYY-Q1 to YYYY-Q4 for a quarter.'
const FILES = [
  'b2b.csv',
  'b2cs.csv',
  'cdnr.csv',
  'hsn-b2b.csv',
  'hsn-b2c.csv',
  'docs.csv',
  'late-credit-notes.csv',
]

beforeEach(async () => {
  gst.on = true
  await resetTaxDocuments()
})

afterEach(async () => {
  gst.on = true
  await resetTaxDocuments()
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

afterAll(async () => {
  await closeQueue()
  await closeRedis()
})

/**
 * Store one invoice of a workspace (or of none, as after a purge).
 * @param tenantId - The workspace, or null.
 * @param number - The document number, unique in the file.
 * @param issuedAt - When it was issued, as an ISO string.
 * @param overrides - Columns to change.
 */
async function store(
  tenantId: string | null,
  number: string,
  issuedAt: string,
  overrides: Partial<NewTaxDocument> = {}
): Promise<void> {
  await withTransaction((tx) =>
    taxRepository.insertDocument(
      taxDocumentRow(tenantId, { number, issuedAt: new Date(issuedAt), ...overrides }),
      tx
    )
  )
}

/**
 * GET the export with the body read as bytes.
 * @param token - The bearer token.
 * @param period - The period query, or undefined for none.
 * @returns The response; `body` is a Buffer.
 */
function exportAs(token: string, period: string | undefined) {
  const query = period === undefined ? '' : `?period=${encodeURIComponent(period)}`
  return request(app)
    .get(`/api/v1/platform/billing/tax-export${query}`)
    .set('Authorization', `Bearer ${token}`)
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
 * A JSON error body read from the raw bytes.
 * @param body - The response body as bytes.
 * @returns The parsed body.
 */
function jsonOf(body: unknown): { code?: string; message?: string; errors?: unknown } {
  return JSON.parse((body as Buffer).toString('utf8')) as {
    code?: string
    message?: string
    errors?: unknown
  }
}

/**
 * The zip's entries as text.
 * @param body - The response body as bytes.
 * @returns Each entry's name and text.
 */
function entriesOf(body: unknown): Record<string, string> {
  const files = unzipSync(new Uint8Array(body as Buffer))
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]))
}

/**
 * The document numbers docs.csv lists, from and to, per series.
 * @param entries - The zip's entries.
 * @returns The data rows of docs.csv.
 */
function seriesRows(entries: Record<string, string>): string[] {
  return (entries['docs.csv'] ?? '').split('\r\n').slice(1, -1)
}

describe('GET /platform/billing/tax-export', () => {
  it('gives an admin with a recent sign-in a zip of the month, by IST issue date', async () => {
    const { tenant } = await workspace()
    // 1 Oct 2026, 00:00 IST: the first instant of October.
    await store(tenant.id, 'INV/26-27/00001', '2026-09-30T18:30:00.000Z')
    await store(tenant.id, 'INV/26-27/00002', '2026-10-27T06:30:00.000Z')
    // 1 Nov 2026, 00:00 IST: November, so left out.
    await store(tenant.id, 'INV/26-27/00003', '2026-10-31T18:30:00.000Z')
    // 30 Sep 2026, 23:59 IST: September, so left out.
    await store(tenant.id, 'INV/26-27/00000', '2026-09-30T18:29:00.000Z')
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/zip')
    expect(response.headers['content-disposition']).toBe('attachment; filename="gstr1-2026-10.zip"')
    expect(response.headers['cache-control']).toBe('private, no-store')
    const entries = entriesOf(response.body)
    expect(Object.keys(entries)).toEqual(FILES)
    expect(seriesRows(entries)).toEqual([
      'Invoices for outward supply,INV/26-27/00001,INV/26-27/00002,2,0',
    ])
  })

  it('reads 2026-Q4 as January to March 2027', async () => {
    const { tenant } = await workspace()
    await store(tenant.id, 'INV/26-27/00001', '2026-12-31T18:29:00.000Z')
    // 1 Jan 2027, 00:00 IST.
    await store(tenant.id, 'INV/26-27/00002', '2026-12-31T18:30:00.000Z')
    await store(tenant.id, 'INV/26-27/00003', '2027-01-15T06:30:00.000Z')
    await store(tenant.id, 'INV/26-27/00004', '2027-03-31T18:29:00.000Z')
    // 1 Apr 2027, 00:00 IST: the next financial year.
    await store(tenant.id, 'INV/27-28/00001', '2027-03-31T18:30:00.000Z', {
      financialYear: '27-28',
    })
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-Q4')

    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toBe('attachment; filename="gstr1-2026-Q4.zip"')
    expect(seriesRows(entriesOf(response.body))).toEqual([
      'Invoices for outward supply,INV/26-27/00002,INV/26-27/00004,3,0',
    ])
  })

  it('answers an empty period with headers only', async () => {
    const { tenant } = await workspace()
    await store(tenant.id, 'INV/26-27/00001', '2026-10-27T06:30:00.000Z')
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-11')

    expect(response.status).toBe(200)
    const entries = entriesOf(response.body)
    for (const name of FILES) {
      expect(entries[name]?.split('\r\n')).toHaveLength(2)
    }
  })

  it.each([
    '2026-13',
    '2026-Q5',
    '26-10',
    '2026-10-01',
    '',
    '1979-12',
    '2016-12',
    '2100-01',
    '2099-Q4',
  ])('refuses the period %j with a field error', async (period) => {
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, period)

    expect(response.status).toBe(400)
    expect(jsonOf(response.body).errors).toEqual({ period: [PERIOD_MESSAGE] })
  })

  it('refuses a missing period with the same field error', async () => {
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, undefined)

    expect(response.status).toBe(400)
    expect(jsonOf(response.body).errors).toEqual({ period: [PERIOD_MESSAGE] })
  })

  it.each(['viewer', 'manager'] as const)('answers a %s the unknown-route 404', async (role) => {
    const { token } = await createTrackedStaff(role)

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(404)
    expect(jsonOf(response.body).message).toBe(NOT_FOUND.route.message)
  })

  it('asks an admin with a stale sign-in to confirm it is them', async () => {
    const { user } = await createTrackedStaff('admin')

    const response = await exportAs(staleAuthTokenFor(user), '2026-10')

    expect(response.status).toBe(401)
    expect(jsonOf(response.body).code).toBe(REAUTH_REQUIRED_CODE)
  })

  it('records one audit entry in the platform tenant per download, naming the period', async () => {
    const { user, token } = await createTrackedStaff('admin')
    const platform = await platformTenant()

    await exportAs(token, '2026-10')

    const rows = await sql<
      {
        tenantId: string
        actorUserId: string
        access: string
        targetType: string
        targetId: string
        metadata: unknown
      }[]
    >`
      select tenant_id as "tenantId", actor_user_id as "actorUserId", access,
        target_type as "targetType", target_id as "targetId", metadata
      from audit_logs where action = 'billing.tax_export_downloaded'`
    expect([...rows]).toEqual([
      {
        tenantId: platform.id,
        actorUserId: user.id,
        access: 'platform',
        targetType: 'platform',
        targetId: platform.id,
        metadata: { period: '2026-10' },
      },
    ])
  })

  it('records nothing for a refused period', async () => {
    const { token } = await createTrackedStaff('admin')

    await exportAs(token, '2026-13')

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_logs where action = 'billing.tax_export_downloaded'`
    expect(row?.count).toBe(0)
  })

  it("still exports a purged workspace's documents", async () => {
    const { tenant } = await workspace()
    await store(tenant.id, 'INV/26-27/00001', '2026-10-27T06:30:00.000Z')
    await sql`delete from tenants where id = ${tenant.id}`
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(200)
    expect(seriesRows(entriesOf(response.body))).toEqual([
      'Invoices for outward supply,INV/26-27/00001,INV/26-27/00001,1,0',
    ])
  })

  it('builds the same bytes twice for one period', async () => {
    const { tenant } = await workspace()
    await store(tenant.id, 'INV/26-27/00001', '2026-10-27T06:30:00.000Z')
    const { token } = await createTrackedStaff('admin')

    const first = await exportAs(token, '2026-10')
    const second = await exportAs(token, '2026-10')

    expect(first.status).toBe(200)
    expect(Buffer.compare(first.body as Buffer, second.body as Buffer)).toBe(0)
  })

  it('answers the export 404 while registration is off and no workspace has documents', async () => {
    gst.on = false
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(404)
    expect(jsonOf(response.body)).toMatchObject({
      code: 'tax_documents_disabled',
      message: EXPORT_DISABLED,
    })
  })

  it('records nothing for the registration-off 404', async () => {
    gst.on = false
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(404)
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from audit_logs where action = 'billing.tax_export_downloaded'`
    expect(row?.count).toBe(0)
  })

  it('keeps exporting while registration is off and documents exist', async () => {
    gst.on = false
    await store(null, `INV/26-27/${randomUUID().slice(0, 5)}`, '2026-06-01T06:30:00.000Z')
    const { token } = await createTrackedStaff('admin')

    const response = await exportAs(token, '2026-10')

    expect(response.status).toBe(200)
    expect(Object.keys(entriesOf(response.body))).toEqual(FILES)
  })
})
