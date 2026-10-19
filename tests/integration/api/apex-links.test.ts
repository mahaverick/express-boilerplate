/**
 * @file Which frontend each mailed link points at once APEX_URL is set: the
 * platform tenant's invitations go to Apex, and a sign-in link follows the
 * request's `app`. APEX_URL is stubbed before the app is imported, since
 * getEnv() is read once per process.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import type { User } from '@/database/models/user.model'
import type { EmailJobData } from '@/jobs/email.job'
import type { sql as SqlType } from '@/services/database.service'
import { request } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const WEB = 'http://localhost:5173'
const LINK_REQUEST = '/api/v1/auth/link/request'

/**
 * POST a body with `app: 'apex'` added.
 * @param app - The app under test.
 * @param path - The route.
 * @param body - The request body.
 * @returns The response.
 */
function postApex(app: ReturnType<typeof CreateApp>, path: string, body: Record<string, unknown>) {
  return request(app)
    .post(path)
    .send({ ...body, app: 'apex' })
}

/**
 * A response body without its per-request `requestId`, so two bodies can be compared.
 * @param body - A parsed response body.
 * @returns A copy with `requestId` removed.
 */
function withoutRequestId(body: unknown): unknown {
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) }
  delete copy.requestId
  return copy
}

/**
 * Wait for the sign-in link mail queued to `to` and return its link.
 * @param to - The recipient.
 * @returns The link.
 */
async function queuedSignInLink(to: string): Promise<string> {
  const { waitForJob } = await import('../../helpers/queue-jobs')
  const { getEmailQueue } = await import('@/services/queue.service')
  const job = await waitForJob<EmailJobData>(
    getEmailQueue(),
    (data) => data.to === to && data.templateKey === 'sign_in_link'
  )
  const link: unknown = Reflect.get(job.data.variables, 'signInUrl')
  if (typeof link !== 'string') throw new Error('the sign_in_link job carries no signInUrl')
  return link
}

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

  // The auth routes' per-IP limiters would otherwise turn later cases into 429s.
  beforeEach(async () => {
    const { getRedis, redisKey } = await import('@/services/redis.service')
    const client = await getRedis()
    const keys: string[] = []
    const batches = client.scanIterator({ MATCH: `${redisKey('rl')}:*`, COUNT: 100 })
    for await (const batch of batches) {
      keys.push(...batch)
    }
    if (keys.length > 0) await client.del(keys)
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
    // Recent: every platform-tenant invitation needs a recent sign-in.
    return signAccessToken(user, randomUUID(), new Date())
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

  /**
   * Create an unverified user directly.
   * @param label - An address prefix.
   * @returns The user.
   */
  async function createUser(label: string): Promise<User> {
    const { UserRepository } = await import('@/repositories/user.repository')
    const user = await new UserRepository().create({
      email: `${label}-${randomUUID()}@example.test`,
    })
    createdUserIds.push(user.id)
    return user
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

  describe('sign-in links', () => {
    it('mails an APEX_URL sign-in link to a staff member who asks with app apex', async () => {
      const { makeStaff } = await import('../../helpers/platform-staff')
      const user = await createUser('apex-staff')
      await makeStaff(user.id, 'viewer')

      const response = await postApex(app, LINK_REQUEST, { email: user.email })
      expect(response.status).toBe(202)

      expect(new URL(await queuedSignInLink(user.email)).origin).toBe(APEX)
    })

    it('keeps a request without app on WEB_URL', async () => {
      const user = await createUser('apex-web')

      const response = await request(app).post(LINK_REQUEST).send({ email: user.email })
      expect(response.status).toBe(202)

      expect(new URL(await queuedSignInLink(user.email)).origin).toBe(WEB)
    })

    it.each([['https://evil.example'], ['APEX'], [['apex']]])(
      'refuses app %j on a sign-in link request with a 400 that echoes nothing',
      async (value) => {
        const response = await request(app)
          .post(LINK_REQUEST)
          .send({ email: 'nobody@example.test', app: value })

        expect(response.status).toBe(400)
        const body = response.body as { errors?: Record<string, unknown> }
        expect(body.errors).toHaveProperty('app')
        const serialized = JSON.stringify(response.body)
        // The message lists the valid options, so an array's element may legitimately appear there.
        if (typeof value === 'string') expect(serialized).not.toContain(value)
        expect(serialized).not.toContain(JSON.stringify(value))
      }
    )

    it('answers a sign-in link request identically for an existing and an unknown address under app apex', async () => {
      const existing = await createUser('apex-existing')
      const known = await postApex(app, LINK_REQUEST, { email: existing.email })
      const unknown = await postApex(app, LINK_REQUEST, {
        email: `apex-unknown-${randomUUID()}@example.test`,
      })

      expect(known.status).toBe(unknown.status)
      expect(withoutRequestId(known.body)).toEqual(withoutRequestId(unknown.body))
    })
  })
})
