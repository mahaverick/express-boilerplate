/**
 * @file The maintenance-mode gate through the real app, with this worker's
 * process store reloaded from the real row: the `Maintenance-Mode` header
 * on every response (let through, refused, 404, error), the 503 body and
 * `Retry-After` for both codes, CORS on a refusal and on a preflight,
 * sign-in in `full` (non-staff refused after the credential check, staff
 * admitted, refresh still answered by its own handler), and the public
 * status endpoint (shape, cache header, rate limit), and the staff pass on
 * the customer routes Apex calls.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { RATE_LIMITS } from '@/constants/rate-limit.constants'
import type { Tenant } from '@/database/models/tenant.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { sql } from '@/services/database.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  TEST_PASSWORD,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const tenantIds: string[] = []
const allowedOrigin = process.env.WEB_URL ?? 'http://localhost:5173'
const SINCE = new Date('2026-10-06T10:42:00.000Z')
// eslint-disable-next-line unicorn/no-null -- the API's contract uses null for "none"
const NONE = null

/**
 * Store a mode and load it into this process's store, as a published change would.
 * @param mode - The mode.
 * @param message - The customer message.
 */
async function enter(
  mode: 'read_only' | 'full',
  message = 'Upgrading the database.'
): Promise<void> {
  await storeMaintenanceMode(mode, { message, changedAt: SINCE })
  await reloadMaintenanceMode()
}

/**
 * A tenant owned by a fresh customer.
 * @returns The tenant and its owner's token.
 */
async function customerTenant(): Promise<{ tenant: Tenant; ownerToken: string }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Gate Co',
    slug: `gate-${owner.id.slice(0, 8)}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  return { tenant, ownerToken: tokenFor(owner) }
}

beforeEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await resetMaintenanceMode()
})

describe('Maintenance-Mode header', () => {
  it('is on every response while off, the 404 and the health check included', async () => {
    const health = await request(app).get('/health')
    const unknown = await request(app).get('/api/v1/definitely-not-a-route')

    expect(health.headers['maintenance-mode']).toBe('off')
    expect(unknown.status).toBe(404)
    expect(unknown.headers['maintenance-mode']).toBe('off')
  })

  it('names the mode on a let-through response and on a handler error', async () => {
    await enter('read_only')
    const { token } = await createTrackedStaff('viewer')

    const staffRead = await request(app)
      .get('/api/v1/platform/stats')
      .set('Authorization', `Bearer ${token}`)
    const unauthenticated = await request(app).get('/api/v1/profile')

    expect(staffRead.status).toBe(200)
    expect(staffRead.headers['maintenance-mode']).toBe('read_only')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers['maintenance-mode']).toBe('read_only')
  })
})

describe('refusals', () => {
  it('answers a write in read_only 503 READ_ONLY_MODE with the message, mode, since and Retry-After', async () => {
    await enter('read_only', 'Read only while we migrate.')
    const user = await createTrackedUser()

    const response = await request(app)
      .patch('/api/v1/profile')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ firstName: 'Ada' })

    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('30')
    expect(response.headers['maintenance-mode']).toBe('read_only')
    expect(response.body).toMatchObject({
      success: false,
      statusCode: 503,
      code: 'READ_ONLY_MODE',
      message: 'Read only while we migrate.',
      mode: 'read_only',
      since: SINCE.toISOString(),
    })
    const [row] = await sql<{ firstName: string | null }[]>`
      select first_name as "firstName" from users where id = ${user.id}`
    expect(row?.firstName).toBeNull()
  })

  it('lets a read through in read_only and refuses it in full with MAINTENANCE_MODE', async () => {
    const user = await createTrackedUser()
    await enter('read_only')
    const readOnly = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    await enter('full', 'Down for an upgrade.')
    const full = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(readOnly.status).toBe(200)
    expect(full.status).toBe(503)
    expect(full.body).toMatchObject({ code: 'MAINTENANCE_MODE', message: 'Down for an upgrade.' })
    expect(full.headers['retry-after']).toBe('30')
  })

  it('never logs nor masks a refusal', async () => {
    await enter('full')
    const response = await request(app).get('/api/v1/tenants')

    expect(response.status).toBe(503)
    expect(response.body).not.toHaveProperty('errorId')
  })

  it('carries the CORS grant and exposed headers on a cross-origin refusal; a preflight is answered by cors', async () => {
    await enter('full')

    const refused = await request(app).get('/api/v1/tenants').set('Origin', allowedOrigin)
    const preflight = await request(app)
      .options('/api/v1/tenants')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')

    expect(refused.status).toBe(503)
    expect(refused.headers['access-control-allow-origin']).toBe(allowedOrigin)
    expect(refused.headers['access-control-expose-headers']).toBe(
      'X-Request-Id,Maintenance-Mode,Retry-After'
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe(allowedOrigin)
  })
})

describe('sign-in in full', () => {
  it('refuses a non-staff login with the right password 503 MAINTENANCE_MODE, writing nothing', async () => {
    const user = await createTrackedUser({ hasPassword: true })
    await enter('full', 'Back at noon.')

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ code: 'MAINTENANCE_MODE', message: 'Back at noon.' })
    expect(response.headers['set-cookie']).toBeUndefined()
    const [row] = await sql<{ lastLoggedInAt: Date | null; sessions: number }[]>`
      select last_logged_in_at as "lastLoggedInAt",
        (select count(*)::int from user_tokens where user_id = ${user.id}) as sessions
      from users where id = ${user.id}`
    expect(row).toEqual({ lastLoggedInAt: NONE, sessions: 0 })
  })

  it('still answers a wrong password 401, so the refusal reveals nothing more than a login would', async () => {
    const user = await createTrackedUser({ hasPassword: true })
    await enter('full')

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not-the-password-1' })

    expect(response.status).toBe(401)
  })

  it('admits staff', async () => {
    const { user } = await createTrackedStaff('viewer', { hasPassword: true })
    await enter('full')

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })

    expect(response.status).toBe(200)
  })

  it('admits a non-staff login in read_only', async () => {
    const user = await createTrackedUser({ hasPassword: true })
    await enter('read_only')

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })

    expect(response.status).toBe(200)
  })

  it('lets the profile read through, which a session restore needs after every refresh', async () => {
    const user = await createTrackedUser()
    await enter('full')

    const response = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${tokenFor(user)}`)

    expect(response.status).toBe(200)
  })

  it('leaves refresh to its own handler, which answers 401 without a cookie', async () => {
    await enter('full')

    const response = await request(app).post('/api/v1/auth/refresh').send({})

    expect(response.status).toBe(401)
    expect(response.headers['maintenance-mode']).toBe('full')
  })

  it('refuses registration in both modes', async () => {
    await enter('read_only')
    const readOnly = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'someone@example.test', password: 'long-enough-password-1' })
    await enter('full')
    const full = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'someone@example.test', password: 'long-enough-password-1' })

    const codes = [readOnly, full].map((response) => (response.body as { code?: string }).code)
    expect(codes).toEqual(['READ_ONLY_MODE', 'MAINTENANCE_MODE'])
  })
})

describe('GET /api/v1/status/maintenance', () => {
  it('answers the mode, message and since, cacheable for 5 s, in full', async () => {
    await enter('full', 'Upgrading.')

    const response = await request(app).get('/api/v1/status/maintenance')

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('public, max-age=5')
    expect((response.body as { data: unknown }).data).toEqual({
      mode: 'full',
      message: 'Upgrading.',
      since: SINCE.toISOString(),
    })
  })

  it('answers off with no message or since', async () => {
    const response = await request(app).get('/api/v1/status/maintenance')

    expect((response.body as { data: unknown }).data).toEqual({
      mode: 'off',
      message: NONE,
      since: NONE,
    })
  })

  it(`answers 429 after ${String(RATE_LIMITS.maintenanceStatus.limit)} requests a minute from one IP`, async () => {
    const statuses: number[] = []
    for (let index = 0; index <= RATE_LIMITS.maintenanceStatus.limit; index += 1) {
      const response = await request(app).get('/api/v1/status/maintenance')
      statuses.push(response.status)
    }

    // Earlier tests in this file spent part of this IP's budget, so only the bound is exact.
    expect(statuses.at(-1)).toBe(429)
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(
      RATE_LIMITS.maintenanceStatus.limit
    )
  })
})

describe('staff pass on the customer routes Apex calls', () => {
  it('lets staff read a tenant in full and refuses its own owner', async () => {
    const { tenant, ownerToken } = await customerTenant()
    const { token: staffToken } = await createTrackedStaff('viewer')
    await enter('full', 'Down.')

    const staff = await request(app)
      .get(`/api/v1/tenants/${tenant.slug}`)
      .set('Authorization', `Bearer ${staffToken}`)
    const owner = await request(app)
      .get(`/api/v1/tenants/${tenant.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`)

    expect(staff.status).toBe(200)
    expect(staff.headers['maintenance-mode']).toBe('full')
    expect(owner.status).toBe(503)
    expect(owner.headers['retry-after']).toBe('30')
    expect(owner.body).toMatchObject({ code: 'MAINTENANCE_MODE', message: 'Down.', mode: 'full' })
  })

  it('lets staff write a tenant in read_only and refuses its own owner READ_ONLY_MODE', async () => {
    const { tenant, ownerToken } = await customerTenant()
    const { token: staffToken } = await createTrackedStaff('admin')
    await enter('read_only')

    const staff = await request(app)
      .patch(`/api/v1/tenants/${tenant.slug}`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'Renamed by staff' })
    const owner = await request(app)
      .patch(`/api/v1/tenants/${tenant.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Renamed by owner' })

    expect(staff.status).toBe(200)
    expect(owner.status).toBe(503)
    expect((owner.body as { code?: string }).code).toBe('READ_ONLY_MODE')
  })

  it('answers an anonymous call 401, as requireAuth does before the staff check', async () => {
    const { tenant } = await customerTenant()
    await enter('full')

    const response = await request(app).get(`/api/v1/tenants/${tenant.slug}`)

    expect(response.status).toBe(401)
  })

  it('still refuses staff on a customer route Apex does not call', async () => {
    const { token } = await createTrackedStaff('owner')
    await enter('full')

    const response = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(503)
  })
})
