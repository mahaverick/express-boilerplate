/**
 * @file Which frontend each mailed link points at once APEX_URL is set: the
 * platform tenant's invitations go to Apex, every other link follows the
 * request's `app`. APEX_URL is stubbed before the app is imported, since
 * getEnv() is read once per process.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { createApp as CreateApp } from '@/app'
import type { User } from '@/database/models/user.model'
import type { NotificationJobData } from '@/jobs/notification.job'
import type { sql as SqlType } from '@/services/database.service'
import { request } from '../../helpers/request'

const APEX = 'http://localhost:5174'
const WEB = 'http://localhost:5173'

/**
 * Wait for a queued notification job and return its email's link variable.
 * @param userId - The user the job is for.
 * @param type - The notification type.
 * @param key - Which variable holds the link.
 * @returns The link.
 */
async function queuedLink(
  userId: string,
  type: 'verify_email' | 'password_reset_requested',
  key: 'verificationUrl' | 'resetUrl'
): Promise<string> {
  const { waitForJob } = await import('../../helpers/queue-jobs')
  const { getNotificationQueue } = await import('@/services/queue.service')
  const job = await waitForJob<NotificationJobData>(
    getNotificationQueue(),
    (data) => data.userId === userId && data.type === type
  )
  const link: unknown = Reflect.get(job.data.email?.variables ?? {}, key)
  if (typeof link !== 'string') throw new Error(`the ${type} job carries no ${key}`)
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

  /**
   * Register an address and return the user it created.
   * @param body - Extra body fields, such as `app`.
   * @returns The created user.
   */
  async function registerUser(body: Record<string, unknown>): Promise<User> {
    const { UserRepository } = await import('@/repositories/user.repository')
    const email = `apex-register-${randomUUID()}@example.test`
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct horse battery staple', ...body })
    expect(response.status).toBe(202)
    const user = await new UserRepository().findByEmail(email)
    if (!user) throw new Error('register did not create the user')
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

  describe('verification and reset links', () => {
    it('mails an APEX_URL verification link to an address registered with app apex', async () => {
      const user = await registerUser({ app: 'apex' })
      const link = await queuedLink(user.id, 'verify_email', 'verificationUrl')
      expect(new URL(link).origin).toBe(APEX)
    })

    it('keeps a register without app on WEB_URL', async () => {
      const user = await registerUser({})
      const link = await queuedLink(user.id, 'verify_email', 'verificationUrl')
      expect(new URL(link).origin).toBe(WEB)
    })

    it('mails an APEX_URL reset link for forgot-password with app apex', async () => {
      const user = await createUser('apex-reset')
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email, app: 'apex' })
      expect(response.status).toBe(202)

      const link = await queuedLink(user.id, 'password_reset_requested', 'resetUrl')
      expect(new URL(link).origin).toBe(APEX)
    })

    it('mails an APEX_URL link on resend-verification with app apex', async () => {
      const user = await createUser('apex-resend')
      const response = await request(app)
        .post('/api/v1/auth/resend-verification')
        .send({ email: user.email, app: 'apex' })
      expect(response.status).toBe(202)

      const link = await queuedLink(user.id, 'verify_email', 'verificationUrl')
      expect(new URL(link).origin).toBe(APEX)
    })

    it.each([['https://evil.example'], ['APEX'], [['apex']]])(
      'refuses app %j on register and forgot-password with a 400 that echoes nothing',
      async (value) => {
        const register = await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: `apex-bad-${randomUUID()}@example.test`,
            password: 'correct horse battery staple',
            app: value,
          })
        const forgot = await request(app)
          .post('/api/v1/auth/forgot-password')
          .send({ email: 'nobody@example.test', app: value })
        for (const response of [register, forgot]) {
          expect(response.status).toBe(400)
          expect(JSON.stringify(response.body)).not.toContain('evil.example')
        }
      }
    )

    it('answers resend-verification with the same 202 for a bad app', async () => {
      const response = await request(app)
        .post('/api/v1/auth/resend-verification')
        .send({ email: 'nobody@example.test', app: 'https://evil.example' })
      expect(response.status).toBe(202)
    })

    it('answers forgot-password identically for a known and an unknown address under app apex', async () => {
      const user = await createUser('apex-known')
      const known = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email, app: 'apex' })
      const unknown = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: `apex-unknown-${randomUUID()}@example.test`, app: 'apex' })
      expect(known.status).toBe(unknown.status)
      expect(known.body).toEqual(unknown.body)
    })
  })
})
