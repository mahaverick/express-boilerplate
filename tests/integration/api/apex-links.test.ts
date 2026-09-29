/**
 * @file Which frontend each mailed link points at once APEX_URL is set: the
 * platform tenant's invitations go to Apex, every other link follows the
 * request's `app`. APEX_URL is stubbed before the app is imported, since
 * getEnv() is read once per process.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import type { sql as SqlType } from '@/services/database.service'
import { request } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const WEB = 'http://localhost:5173'

describe('links once APEX_URL is set', () => {
  let app: ReturnType<typeof CreateApp>
  let sql: typeof SqlType
  const createdUserIds: string[] = []
  const createdTenantIds: string[] = []

  beforeAll(async () => {
    vi.stubEnv('APEX_URL', APEX)
    const { createApp } = await import('@/app')
    app = createApp()
    ;({ sql } = await import('@/services/database.service'))
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    const { truncateAuditLogs } = await import('../../helpers/audit-log')
    await truncateAuditLogs()
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A signed-in platform owner, able to invite to the platform tenant.
   * @returns Their access token.
   */
  async function platformOwnerToken(): Promise<string> {
    const { UserRepository } = await import('@/repositories/user.repository')
    const { signAccessToken } = await import('@/services/session.service')
    const { makeStaff } = await import('../../helpers/platform-staff')
    const user = await new UserRepository().create({
      email: `apex-owner-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    await makeStaff(user.id, 'owner')
    return signAccessToken(user, randomUUID())
  }

  /**
   * A customer tenant owned by a fresh user.
   * @returns The owner's token and the tenant's slug.
   */
  async function customerOwner(): Promise<{ token: string; slug: string }> {
    const { UserRepository } = await import('@/repositories/user.repository')
    const { TenantRepository } = await import('@/repositories/tenant.repository')
    const { signAccessToken } = await import('@/services/session.service')
    const user = await new UserRepository().create({
      email: `apex-customer-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    const slug = `apex-${randomUUID().slice(0, 8)}`
    // create() also inserts the owner membership.
    const tenant = await new TenantRepository().create({ name: slug, slug, ownerId: user.id })
    createdTenantIds.push(tenant.id)
    return { token: signAccessToken(user, randomUUID()), slug }
  }

  describe('invitations', () => {
    it('points a platform-tenant invitation at APEX_URL', async () => {
      const { waitForInvitationEmail } = await import('../../helpers/queue-jobs')
      const email = `apex-invitee-${randomUUID()}@example.test`
      const response = await request(app)
        .post('/api/v1/tenants/platform/invitations')
        .set('Authorization', `Bearer ${await platformOwnerToken()}`)
        .send({ email, role: 'viewer' })
      expect(response.status).toBe(202)

      const { variables } = await waitForInvitationEmail(email)
      expect(new URL(variables.acceptUrl).origin).toBe(APEX)
      expect(new URL(variables.acceptUrl).pathname).toBe('/invitations/accept')
    })

    it('keeps a customer-tenant invitation on WEB_URL', async () => {
      const { waitForInvitationEmail } = await import('../../helpers/queue-jobs')
      const { token, slug } = await customerOwner()
      const email = `apex-invitee-${randomUUID()}@example.test`
      const response = await request(app)
        .post(`/api/v1/tenants/${slug}/invitations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email, role: 'viewer' })
      expect(response.status).toBe(202)

      const { variables } = await waitForInvitationEmail(email)
      expect(new URL(variables.acceptUrl).origin).toBe(WEB)
    })
  })
})
