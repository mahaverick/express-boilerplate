/**
 * @file The owner's tax details routes end to end against the real database:
 * the gate when registration is off (with and without documents), the first
 * save and a PATCH of changed fields, the version check, the cross-field
 * rules on the merged row, the empty change, curly quotes, who may call the
 * routes, the audit entry and its forwarded event, and maintenance mode.
 * Registration is switched per test through a mocked `gstSellerConfig`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import {
  TAX_DETAILS_OWNER_ONLY_MESSAGE,
  TAX_DOCUMENTS_OWNER_ONLY_MESSAGE,
} from '@/constants/billing.constants'
import { taxDocumentModel } from '@/database/models/tax.model'
import type { User } from '@/database/models/user.model'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { saveTaxDetails } from '@/services/billing/tax-details.service'
import { db, sql, type DbExecutor } from '@/services/database.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { clearOutbox, outboxRowsOf } from '../../helpers/analytics-outbox'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deleteTrackedTenants, workspace } from '../../helpers/billing-api'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'
import { resetTaxDocuments, taxDocumentRow } from '../../helpers/tax'

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

vi.mock('@/configs/analytics.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configs/analytics.config')>()
  return { ...actual, isAnalyticsEnabled: () => true }
})

const app = createApp()
const membershipRepository = new UserMembershipRepository()

const READ_DISABLED = 'Tax documents are off, and this workspace has none to download.'
const WRITE_DISABLED =
  "Tax documents are off, so tax details and credit notes can't change. Issued documents stay available to download."
const SAVED = 'Tax details saved. They apply to invoices issued from now on.'
const CONFLICT =
  'Someone changed these tax details since you opened them. Reload to see them, then save again.'
const NO_CHANGE = 'Change at least one tax detail before saving.'

/**
 * Matches any string, typed so a strict comparison accepts it.
 */
const ANY_STRING = expect.any(String) as unknown as string

/**
 * A complete first save for a Karnataka buyer with a GSTIN.
 */
const FIRST_SAVE = {
  version: null,
  gstin: '29ABCDE1234F1ZW',
  legalName: 'Acme Traders',
  addressLine1: '12 MG Road',
  city: 'Bengaluru',
  pincode: '560001',
  stateCode: '29',
}

beforeEach(async () => {
  gst.on = true
  await resetTaxDocuments()
  await clearOutbox()
})

afterEach(async () => {
  gst.on = true
  await resetTaxDocuments()
  await clearOutbox()
  await truncateAuditLogs()
  await deleteTrackedTenants()
  await deleteTrackedUsers()
})

/**
 * GET a workspace's tax details as `user`.
 * @param user - The caller.
 * @param slug - The workspace slug.
 * @returns The response.
 */
function getDetails(user: User, slug: string) {
  return request(app)
    .get(`/api/v1/tenants/${slug}/billing/tax-details`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
}

/**
 * PATCH a workspace's tax details as `user`.
 * @param user - The caller.
 * @param slug - The workspace slug.
 * @param body - The JSON body.
 * @returns The response.
 */
function patchDetails(user: User, slug: string, body: object) {
  return request(app)
    .patch(`/api/v1/tenants/${slug}/billing/tax-details`)
    .set('Authorization', `Bearer ${tokenFor(user)}`)
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
 * The details a GET answers the owner now.
 * @param user - The caller.
 * @param slug - The workspace slug.
 * @returns The response's data.
 */
async function storedView(user: User, slug: string): Promise<Record<string, unknown>> {
  const response = await getDetails(user, slug)
  return dataOf(response.body)
}

/**
 * The field errors of a 400.
 * @param body - The response body.
 * @returns Its `errors`.
 */
function errorsOf(body: unknown): Record<string, string[]> {
  return (body as { errors: Record<string, string[]> }).errors
}

/**
 * The tax details audit entries of a workspace, oldest first.
 * @param tenantId - The workspace.
 * @returns Each entry's access and metadata.
 */
async function detailsAudit(tenantId: string): Promise<{ access: string; metadata: unknown }[]> {
  return sql<{ access: string; metadata: unknown }[]>`
    select access, metadata from audit_logs
    where tenant_id = ${tenantId} and action = 'billing.tax_details_updated'
    order by occurred_at, id`
}

/**
 * A workspace with saved tax details (version 1).
 * @returns The workspace and its owner.
 */
async function savedWorkspace() {
  const created = await workspace()
  const response = await patchDetails(created.owner, created.tenant.slug, FIRST_SAVE)
  expect(response.status).toBe(200)
  return created
}

describe('registration off', () => {
  it('answers 404 to the read and the write when the workspace has no documents', async () => {
    const { tenant, owner } = await workspace()
    gst.on = false

    const read = await getDetails(owner, tenant.slug)
    const write = await patchDetails(owner, tenant.slug, FIRST_SAVE)

    expect(read.status).toBe(404)
    expect(read.body).toMatchObject({ code: 'tax_documents_disabled', message: READ_DISABLED })
    expect(write.status).toBe(404)
    expect(write.body).toMatchObject({ code: 'tax_documents_disabled', message: WRITE_DISABLED })
  })

  it('keeps the read for a workspace with documents and refuses the write', async () => {
    const { tenant, owner } = await savedWorkspace()
    await db.insert(taxDocumentModel).values(taxDocumentRow(tenant.id))
    gst.on = false

    const read = await getDetails(owner, tenant.slug)
    const write = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })

    expect(read.status).toBe(200)
    expect(dataOf(read.body)).toMatchObject({ legalName: 'Acme Traders', version: 1 })
    expect(write.status).toBe(404)
    expect(write.body).toMatchObject({ code: 'tax_documents_disabled', message: WRITE_DISABLED })
  })
})

describe('GET /api/v1/tenants/:slug/billing/tax-details', () => {
  it('answers null before the first save', async () => {
    const { tenant, owner } = await workspace()

    const response = await getDetails(owner, tenant.slug)

    expect(response.status).toBe(200)
    expect(dataOf(response.body)).toBeNull()
  })

  it('refuses an admin and staff with platform access', async () => {
    const { tenant } = await savedWorkspace()
    const admin = await createTrackedUser()
    await membershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })
    const { user: staff } = await createTrackedStaff('owner')

    for (const caller of [admin, staff]) {
      const response = await getDetails(caller, tenant.slug)
      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ message: TAX_DOCUMENTS_OWNER_ONLY_MESSAGE })
    }
  })
})

describe('PATCH /api/v1/tenants/:slug/billing/tax-details', () => {
  it('saves the first details as version 1', async () => {
    const { tenant, owner } = await workspace()

    const response = await patchDetails(owner, tenant.slug, FIRST_SAVE)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ message: SAVED })
    const data = dataOf(response.body)
    expect(data).toStrictEqual({
      gstin: '29ABCDE1234F1ZW',
      legalName: 'Acme Traders',
      addressLine1: '12 MG Road',
      addressLine2: null,
      city: 'Bengaluru',
      pincode: '560001',
      state: { code: '29', name: 'Karnataka' },
      isSez: false,
      version: 1,
      updatedAt: ANY_STRING,
    })
    expect(await storedView(owner, tenant.slug)).toStrictEqual(data)
    expect(await detailsAudit(tenant.id)).toEqual([
      {
        access: 'member',
        metadata: {
          changedFields: ['gstin', 'legalName', 'addressLine1', 'city', 'pincode', 'stateCode'],
        },
      },
    ])
  })

  it('needs a state and a legal name on the first save', async () => {
    const { tenant, owner } = await workspace()
    const { stateCode: _state, ...noState } = FIRST_SAVE
    const { legalName: _name, ...noName } = FIRST_SAVE

    const missingState = await patchDetails(owner, tenant.slug, noState)
    const missingName = await patchDetails(owner, tenant.slug, noName)

    expect(missingState.status).toBe(400)
    expect(errorsOf(missingState.body)).toStrictEqual({
      stateCode: [
        'Choose the state of your billing address. It sets the tax split on your invoices.',
      ],
    })
    expect(missingName.status).toBe(400)
    expect(errorsOf(missingName.body)).toStrictEqual({
      legalName: ['Enter the legal name to print on your tax invoices.'],
    })
    expect(await storedView(owner, tenant.slug)).toBeNull()
  })

  it('changes only the fields sent and refuses a stale version', async () => {
    const { tenant, owner } = await savedWorkspace()

    const changed = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })
    const stale = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })

    expect(changed.status).toBe(200)
    expect(dataOf(changed.body)).toMatchObject({
      city: 'Mysuru',
      gstin: '29ABCDE1234F1ZW',
      legalName: 'Acme Traders',
      version: 2,
    })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'TAX_DETAILS_VERSION_CONFLICT', message: CONFLICT })
    const audit = await detailsAudit(tenant.id)
    expect(audit.at(-1)).toEqual({ access: 'member', metadata: { changedFields: ['city'] } })
  })

  it('forwards the audit entry as tax_details_saved with the field names only', async () => {
    const { tenant, owner } = await savedWorkspace()
    await clearOutbox()

    await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })

    const rows = await outboxRowsOf('tax_details_saved')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.properties).toMatchObject({ changed_fields: ['city'] })
    expect(JSON.stringify(rows[0]?.properties)).not.toContain('Mysuru')
  })

  it('refuses a version for a workspace with no details and null for one with details', async () => {
    const fresh = await workspace()
    const saved = await savedWorkspace()

    const numberForNone = await patchDetails(fresh.owner, fresh.tenant.slug, {
      ...FIRST_SAVE,
      version: 1,
    })
    const nullForSome = await patchDetails(saved.owner, saved.tenant.slug, FIRST_SAVE)

    expect(numberForNone.status).toBe(409)
    expect(numberForNone.body).toMatchObject({ code: 'TAX_DETAILS_VERSION_CONFLICT' })
    expect(nullForSome.status).toBe(409)
    expect(nullForSome.body).toMatchObject({ code: 'TAX_DETAILS_VERSION_CONFLICT' })
  })

  it('refuses a body with no change, and a change to the stored value, writing nothing', async () => {
    const { tenant, owner } = await savedWorkspace()
    await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })
    const auditBefore = await detailsAudit(tenant.id)

    const versionOnly = await patchDetails(owner, tenant.slug, { version: 2 })
    const sameCity = await patchDetails(owner, tenant.slug, { version: 2, city: 'Mysuru' })

    for (const response of [versionOnly, sameCity]) {
      expect(response.status).toBe(400)
      expect(errorsOf(response.body)).toStrictEqual({ formErrors: [NO_CHANGE] })
    }
    expect(await detailsAudit(tenant.id)).toEqual(auditBefore)
    expect(await storedView(owner, tenant.slug)).toMatchObject({ version: 2 })
  })

  it('refuses a GSTIN with a bad check character', async () => {
    const { tenant, owner } = await workspace()

    const response = await patchDetails(owner, tenant.slug, {
      ...FIRST_SAVE,
      gstin: '29ABCDE1234F1ZX',
    })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({
      gstin: [
        "This GSTIN's last character doesn't match the rest. Check it against your registration certificate.",
      ],
    })
  })

  it('refuses a GSTIN from another state than the stored one', async () => {
    const { tenant, owner } = await savedWorkspace()

    const response = await patchDetails(owner, tenant.slug, {
      version: 1,
      gstin: '27ABCDE1234F1Z0',
    })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({
      stateCode: ['This GSTIN is registered in Maharashtra. Choose Maharashtra as the state.'],
    })
  })

  it('saves a correction next to a stored GSTIN that fails today, and checks it when sent', async () => {
    const { tenant, owner } = await savedWorkspace()
    // A row written before today's checksum rule: the table allows it.
    await sql`update tenant_tax_details set gstin = '29ABCDE1234F1ZX' where tenant_id = ${tenant.id}`

    const city = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })
    const state = await patchDetails(owner, tenant.slug, { version: 2, stateCode: '27' })

    expect(city.status).toBe(200)
    expect(dataOf(city.body)).toMatchObject({ gstin: '29ABCDE1234F1ZX', city: 'Mysuru' })
    expect(state.status).toBe(400)
    expect(errorsOf(state.body)).toStrictEqual({
      stateCode: ['This GSTIN is registered in Karnataka. Choose Karnataka as the state.'],
    })
  })

  it('needs a GSTIN for an SEZ unit', async () => {
    const { tenant, owner } = await savedWorkspace()
    await patchDetails(owner, tenant.slug, { version: 1, isSez: true })

    const response = await patchDetails(owner, tenant.slug, { version: 2, gstin: null })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({
      isSez: ['An SEZ unit has a GSTIN. Enter it first.'],
    })
  })

  it('needs address line 1 with a GSTIN', async () => {
    const { tenant, owner } = await savedWorkspace()

    const response = await patchDetails(owner, tenant.slug, { version: 1, addressLine1: null })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({
      addressLine1: ['Enter address line 1. Invoices with a GSTIN need your registered address.'],
    })
  })

  it('stores a name starting with = as sent, and curly quotes as straight ones', async () => {
    const { tenant, owner } = await savedWorkspace()

    const formula = await patchDetails(owner, tenant.slug, { version: 1, legalName: '=SUM(A1)' })
    const curly = await patchDetails(owner, tenant.slug, {
      version: 2,
      legalName: 'O’Brien Ltd',
    })

    expect(dataOf(formula.body)).toMatchObject({ legalName: '=SUM(A1)' })
    expect(dataOf(curly.body)).toMatchObject({ legalName: "O'Brien Ltd" })
    expect(await storedView(owner, tenant.slug)).toMatchObject({
      legalName: "O'Brien Ltd",
    })
  })

  it('refuses a name in another script', async () => {
    const { tenant, owner } = await savedWorkspace()

    const response = await patchDetails(owner, tenant.slug, { version: 1, legalName: 'नमस्ते' })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({
      legalName: ['Use English letters, digits and common punctuation.'],
    })
  })

  it('refuses an unknown key', async () => {
    const { tenant, owner } = await savedWorkspace()

    const response = await patchDetails(owner, tenant.slug, {
      version: 1,
      city: 'Mysuru',
      hasGstin: true,
    })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body).formErrors).toHaveLength(1)
  })

  it('refuses an owner demoted to admin after the route gate, writing nothing', async () => {
    const { tenant, owner } = await savedWorkspace()
    const auditBefore = await detailsAudit(tenant.id)
    const realFind = UserMembershipRepository.prototype.findByUserAndTenant
    let hasDemoted = false
    /**
     * Returns the real read's row, and after resolveTenant's own pool read of
     * the owner demotes them once, so the route gate saw the old role.
     */
    const demotingFind: typeof realFind = async function (
      this: UserMembershipRepository,
      userId: string,
      tenantId: string,
      executor?: DbExecutor
    ) {
      const row = await realFind.call(this, userId, tenantId, executor)
      if (!hasDemoted && row && executor === undefined && userId === owner.id) {
        hasDemoted = true
        await membershipRepository.updateRole(row.id, 'admin')
      }
      return row
    }

    let status = 0
    let body: unknown
    await withMutatedMethod(
      UserMembershipRepository.prototype,
      'findByUserAndTenant',
      demotingFind,
      async () => {
        const response = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })
        status = response.status
        body = response.body
      }
    )

    expect(hasDemoted).toBe(true)
    expect(status).toBe(403)
    expect(body).toMatchObject({ message: TAX_DETAILS_OWNER_ONLY_MESSAGE })
    const rows = await sql<{ city: string; version: number }[]>`
      select city, version from tenant_tax_details where tenant_id = ${tenant.id}`
    expect(rows).toEqual([{ city: 'Bengaluru', version: 1 }])
    expect(await detailsAudit(tenant.id)).toEqual(auditBefore)
  })

  it('refuses a state change next to a stored GSTIN whose prefix is no longer a state', async () => {
    const { tenant, owner } = await savedWorkspace()
    // A row written before code 25 was retired: the table allows it.
    await sql`
      update tenant_tax_details set gstin = '25ABCDE1234F1Z4', state_code = '25'
      where tenant_id = ${tenant.id}`

    const state = await patchDetails(owner, tenant.slug, { version: 1, stateCode: '27' })
    const city = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })

    expect(state.status).toBe(400)
    expect(errorsOf(state.body)).toStrictEqual({
      gstin: ["This GSTIN's first two digits aren't a state code."],
    })
    expect(city.status).toBe(200)
    expect(dataOf(city.body)).toMatchObject({
      gstin: '25ABCDE1234F1Z4',
      state: { code: '25', name: '25' },
      city: 'Mysuru',
    })
  })

  it('reads a retyped curly apostrophe as no change, writing and auditing nothing', async () => {
    const { tenant, owner } = await savedWorkspace()
    await patchDetails(owner, tenant.slug, { version: 1, legalName: "O'Brien Ltd" })
    const auditBefore = await detailsAudit(tenant.id)

    const response = await patchDetails(owner, tenant.slug, {
      version: 2,
      legalName: 'O\u2019Brien Ltd',
    })

    expect(response.status).toBe(400)
    expect(errorsOf(response.body)).toStrictEqual({ formErrors: [NO_CHANGE] })
    expect(await detailsAudit(tenant.id)).toEqual(auditBefore)
    expect(await storedView(owner, tenant.slug)).toMatchObject({ version: 2 })
  })

  it('refuses an admin and staff with platform access', async () => {
    const { tenant } = await savedWorkspace()
    const admin = await createTrackedUser()
    await membershipRepository.create({ userId: admin.id, tenantId: tenant.id, role: 'admin' })
    const { user: staff } = await createTrackedStaff('owner')

    for (const caller of [admin, staff]) {
      const response = await patchDetails(caller, tenant.slug, { version: 1, city: 'Mysuru' })
      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ message: TAX_DETAILS_OWNER_ONLY_MESSAGE })
    }
  })
})

describe('saveTaxDetails for staff', () => {
  it('records the reason with the changed fields', async () => {
    const { tenant } = await savedWorkspace()
    const { user: staff } = await createTrackedStaff('manager')

    const saved = await saveTaxDetails(
      { userId: staff.id },
      tenant.id,
      { version: 1, city: 'Mysuru' },
      { access: 'platform', reason: 'Customer asked' }
    )

    const audit = await detailsAudit(tenant.id)

    expect(saved).toMatchObject({ city: 'Mysuru', version: 2 })
    expect(audit.at(-1)).toEqual({
      access: 'platform',
      metadata: { changedFields: ['city'], reason: 'Customer asked' },
    })
  })

  it('refuses staff below manager with the unknown-route 404, writing nothing', async () => {
    const { tenant } = await savedWorkspace()
    const { user: staff } = await createTrackedStaff('editor')

    await expect(
      saveTaxDetails(
        { userId: staff.id },
        tenant.id,
        { version: 1, city: 'Mysuru' },
        { access: 'platform', reason: 'Customer asked' }
      )
    ).rejects.toMatchObject({ statusCode: 404, code: 'not_found' })
    const rows = await sql<{ city: string; version: number }[]>`
      select city, version from tenant_tax_details where tenant_id = ${tenant.id}`
    expect(rows).toEqual([{ city: 'Bengaluru', version: 1 }])
  })

  it('refuses a staff save with no reason', async () => {
    const { tenant } = await savedWorkspace()
    const { user: staff } = await createTrackedStaff('manager')

    await expect(
      saveTaxDetails(
        { userId: staff.id },
        tenant.id,
        { version: 1, city: 'Mysuru' },
        { access: 'platform', reason: null }
      )
    ).rejects.toThrow('A staff tax details save needs a reason.')
  })
})

describe('maintenance mode', () => {
  afterEach(async () => {
    await resetMaintenanceMode()
    await reloadMaintenanceMode()
  })

  it('blocks the read in full', async () => {
    const { tenant, owner } = await savedWorkspace()
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()

    const read = await getDetails(owner, tenant.slug)

    expect(read.status).toBe(503)
  })

  it('keeps the read and blocks the write in read_only', async () => {
    const { tenant, owner } = await savedWorkspace()
    await storeMaintenanceMode('read_only')
    await reloadMaintenanceMode()

    const read = await getDetails(owner, tenant.slug)
    const write = await patchDetails(owner, tenant.slug, { version: 1, city: 'Mysuru' })

    expect(read.status).toBe(200)
    expect(write.status).toBe(503)
  })
})
