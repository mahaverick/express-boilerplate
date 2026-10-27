/**
 * @file The three tax analytics events at their call sites, read off the
 * outbox: each one's distinct id (the owner who saved or downloaded, the
 * system for an issue) and tenant group, its documented properties, and no
 * GSTIN, name, address, amount or document number in any property value.
 * Analytics is switched on by mocking `isAnalyticsEnabled`.
 */
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
import { PII_PROPERTY_KEYS, SYSTEM_DISTINCT_ID } from '@/constants/analytics.constants'
import { registerAnalyticsSubscribers } from '@/services/analytics/analytics-forwarder.service'
import { saveTaxDetails } from '@/services/billing/tax-details.service'
import { getDocumentPdf } from '@/services/billing/tax-documents.service'
import { reconcileTaxDocuments } from '@/services/billing/tax-reconcile.service'
import { sql } from '@/services/database.service'
import { closeQueue, getBillingQueue, getEmailQueue } from '@/services/queue.service'
import { closeRedis, getRedis, redisKey } from '@/services/redis.service'
import { clearOutbox, outboxRows } from '../../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import {
  deleteTrackedTenants,
  fake,
  forgetProviderPlans,
  loadPlans,
  makePaying,
  workspace,
} from '../../../helpers/billing-api'
import { deleteTrackedUsers } from '../../../helpers/platform-users'
import { resetTaxDocuments } from '../../../helpers/tax'

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

vi.mock('@/configs/billing.config', async (importOriginal) => {
  const { FIXTURE_SELLER: seller } = await import('../../../helpers/tax-seller')
  return {
    ...(await importOriginal<typeof import('@/configs/billing.config')>()),
    gstSellerConfig: () => seller,
  }
})

vi.mock('@/services/billing/billing-provider.service', async (importOriginal) => {
  const { fakeProviderModule } = await import('../../../helpers/billing-api')
  return {
    ...(await importOriginal<typeof import('@/services/billing/billing-provider.service')>()),
    ...fakeProviderModule(),
  }
})

const NOW = new Date('2026-10-27T06:30:00.000Z')
const BUYER_GSTIN = '29ABCDE1234F1ZW'
const BUYER_NAME = 'Acme Traders'
const BUYER_ADDRESS = '12 MG Road'
const NUMBER_SHAPE = /[A-Z]{2,4}\/\d{2}-\d{2}\//
const PII_KEYS: ReadonlySet<string> = new Set(PII_PROPERTY_KEYS)

beforeAll(async () => {
  await loadPlans()
  registerAnalyticsSubscribers()
})

beforeEach(async () => {
  await resetTaxDocuments()
  await clearOutbox()
})

afterEach(async () => {
  await resetTaxDocuments()
  await getBillingQueue().obliterate({ force: true })
  await getEmailQueue().obliterate({ force: true })
  await clearOutbox()
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
  const redis = await getRedis()
  await redis.del(redisKey('billing-fake'))
})

afterAll(async () => {
  await closeQueue()
  await forgetProviderPlans()
  await closeRedis()
})

describe('tax analytics events', () => {
  it('attributes each event, names its tenant and carries no tax data', async () => {
    const { tenant, owner } = await workspace()
    const { subscriptionId } = await makePaying(tenant.id)
    const charges = await fake.listPaidCharges(subscriptionId)
    const charge = charges.at(-1)
    if (charge === undefined) throw new Error('setup: no charge')
    const paidAt = new Date(NOW.getTime() - 60 * 60 * 1000)
    await fake.fakeShiftBack(subscriptionId, charge.paidAt.getTime() - paidAt.getTime())

    await saveTaxDetails(
      { userId: owner.id },
      tenant.id,
      {
        version: null,
        gstin: BUYER_GSTIN,
        legalName: BUYER_NAME,
        addressLine1: BUYER_ADDRESS,
        city: 'Bengaluru',
        pincode: '560001',
        stateCode: '29',
      },
      { access: 'member', reason: null }
    )
    await reconcileTaxDocuments(tenant.id, { now: NOW })
    const documents = await sql<{ id: string; number: string; total_minor: number }[]>`
      select id, number, total_minor from tax_documents where tenant_id = ${tenant.id}`
    const [document] = documents
    if (document === undefined || documents.length !== 1) throw new Error('setup: no invoice')
    await getDocumentPdf(tenant.id, document.id, { userId: owner.id }, 'web')

    const all = await outboxRows()
    const rows = all.filter(
      (row) => JSON.stringify(row.properties.$groups) === JSON.stringify({ tenant: tenant.id })
    )
    /**
     * The tenant's rows of one event.
     * @param name - The event name.
     * @returns The rows.
     */
    const byEvent = (name: string) => rows.filter((row) => row.event === name)
    expect(byEvent('tax_details_saved')).toHaveLength(1)
    expect(byEvent('tax_document_issued')).toHaveLength(1)
    expect(byEvent('tax_document_downloaded')).toHaveLength(1)
    const [saved] = byEvent('tax_details_saved')
    const [issued] = byEvent('tax_document_issued')
    const [downloaded] = byEvent('tax_document_downloaded')

    expect(saved?.distinctId).toBe(owner.id)
    expect(saved?.properties).toMatchObject({
      $groups: { tenant: tenant.id },
      target_id: tenant.id,
    })
    expect(issued?.distinctId).toBe(SYSTEM_DISTINCT_ID)
    expect(issued?.properties).toMatchObject({
      $groups: { tenant: tenant.id },
      type: 'invoice',
      target_id: document.id,
    })
    expect(downloaded?.distinctId).toBe(owner.id)
    expect(downloaded?.properties).toMatchObject({
      $groups: { tenant: tenant.id },
      type: 'invoice',
      surface: 'web',
    })

    const forbidden = [
      BUYER_GSTIN,
      '29AABCE1234F1Z1',
      BUYER_NAME,
      'Mahaverick Labs',
      BUYER_ADDRESS,
      document.number,
      String(document.total_minor),
    ]
    for (const row of [saved, issued, downloaded]) {
      for (const [key, value] of Object.entries(row?.properties ?? {})) {
        expect(PII_KEYS.has(key), key).toBe(false)
        const text = JSON.stringify(value)
        for (const secret of forbidden) expect(text, `${row?.event}.${key}`).not.toContain(secret)
        expect(text, `${row?.event}.${key}`).not.toMatch(NUMBER_SHAPE)
      }
    }
  })
})
