/**
 * @file The invitation endpoints end to end, against the real Postgres (one database per worker)
 * and the test Redis. No Worker runs: tests read the invitation and verification emails straight
 * off the queues (tests/helpers/queue-jobs.ts).
 *
 * Rate limits here are wiring, not thresholds. The preview limiter (60 per 15 min) is keyed on IP
 * and every request here comes from the same loopback address, so this file's 21 preview
 * requests must stay under 60. Accept (20 per 15 min) is keyed on the signed-in user, not the IP.
 * Thresholds are proven with small overrides in
 * tests/unit/middlewares/rate-limit.middleware.test.ts.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { NOT_FOUND } from '@/errors/not-found-errors'
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import { logger } from '@/services/logger.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken, signAccessToken } from '@/services/session.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { hashRateLimitIdentity } from '@/utilities/rate-limit-key.utilities'
import { invitationListSchema } from '@/validators/tenant.validators'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backdateInvitationSend } from '../../helpers/backdate'
import { withMutatedMethod } from '../../helpers/mutate'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  recentAuthTokenFor,
  tokenFor,
} from '../../helpers/platform-users'
import { expectNoJob, waitForInvitationEmail, waitForJob } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'
import { signInByLink } from '../../helpers/sign-in'
import { settle } from '../../helpers/timing'

/**
 * Every pending invitation of a tenant, read as one page.
 * @param tenantId - The tenant.
 * @returns The page's items.
 */
async function pendingOf(tenantId: string) {
  const { params, filters } = invitationListSchema.parse({ limit: '100' })
  const page = await invitationRepository.listPending(tenantId, params, { roles: filters.role })
  return page.items
}

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const HOUR_MS = 60 * 60 * 1000
const INVITATION_SENT = {
  success: true,
  message: 'If we can invite that address, we sent it an invitation.',
  statusCode: 202,
  // oxlint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
  data: null,
}
const INVALID = {
  success: false,
  statusCode: 404,
  code: 'invitation_invalid',
  message:
    'This invitation link has expired or was already used. Ask the person who invited you for a new one.',
}
const UNVERIFIED = {
  success: false,
  statusCode: 403,
  code: 'invitation_email_unverified',
  message:
    'Confirm your email address before you accept this invitation. Open the invitation link from your inbox.',
}
const MISMATCH = {
  success: false,
  statusCode: 403,
  code: 'invitation_email_mismatch',
  message:
    'This invitation is for a different email address. Sign in with the address it was sent to.',
}

/**
 * The response envelope, narrowed to what these tests read.
 */
interface ApiEnvelope<TData> {
  success: boolean
  message: string
  statusCode: number
  code?: string
  data?: TData
}

/**
 * Types a supertest response body as the API envelope.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email unique to this call, so it cannot collide with rows other
 * tests in this worker's database hold.
 */
function uniqueEmail(): string {
  return `invitation-api-${randomUUID()}@example.test`
}

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * Write an invitation with a known raw token, bypassing the API.
 * @param options.role - The offered role. Defaults to editor.
 * @param options.expiresAt - The expiry. Defaults to an hour from now.
 */
async function seedInvitation(
  tenant: Tenant,
  inviter: User,
  options: { email: string; role?: MembershipRole; expiresAt?: Date }
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email: options.email,
        role: options.role ?? 'editor',
        tokenHash: hashToken(rawToken),
        invitedBy: inviter.id,
        expiresAt: options.expiresAt ?? new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * POST an invitation as `bearer`.
 */
async function inviteVia(slug: string, bearer: string, body: object): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${slug}/invitations`)
    .set('Authorization', `Bearer ${bearer}`)
    .send(body)
}

/**
 * POST the public preview for a token (a JSON body, never the URL).
 * @param token - The raw token (or anything, for malformed cases).
 */
async function previewVia(token: string): Promise<Response> {
  return request(app).post('/api/v1/invitations/preview').send({ token })
}

/**
 * POST an accept, optionally signed in.
 */
async function acceptVia(token: string, bearer?: string): Promise<Response> {
  const pending = request(app).post('/api/v1/invitations/accept')
  if (bearer) pending.set('Authorization', `Bearer ${bearer}`)
  return pending.send({ token })
}

/**
 * Tracked messages enqueued to `recipient` with `templateKey`, after the
 * fire-and-forget follow-up work has had time to run.
 */
async function trackedMailCount(recipient: string, templateKey: string): Promise<number> {
  await settle(1500, 'the mail is enqueued fire-and-forget after the reply; absence has no event')
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from email_messages
    where recipient = ${recipient} and template_key = ${templateKey}
  `
  return rows[0]?.n ?? 0
}

/**
 * The Redis key holding an address's daily invitation-mail count across every tenant.
 */
function recipientBudgetKey(email: string): string {
  return redisKey('rl', 'invitation-recipient', hashRateLimitIdentity(email.trim().toLowerCase()))
}

/**
 * How many invitation mails the address's daily budget has spent, across every tenant.
 * @returns The count; 0 when nothing has been spent.
 */
async function recipientBudgetSpent(email: string): Promise<number> {
  const redis = await getRedis()
  return Number((await redis.get(recipientBudgetKey(email))) ?? 0)
}

/**
 * The origin the CORS config allows.
 */
const allowedOrigin = process.env.WEB_URL ?? 'http://localhost:5173'

/**
 * One page of a tenant's invitations over HTTP, as `bearer`.
 */
async function listVia(
  slug: string,
  bearer: string
): Promise<{
  items: { id: string; lastSentAt: string | null; resendAvailableAt: string | null }[]
}> {
  const response = await request(app)
    .get(`/api/v1/tenants/${slug}/invitations`)
    .set('Authorization', `Bearer ${bearer}`)
  expect(response.status).toBe(200)
  return envelopeOf<Awaited<ReturnType<typeof listVia>>>(response).data ?? { items: [] }
}

/**
 * Resend a pending invitation as `bearer`, with no body, as the clients do.
 */
async function resendVia(slug: string, bearer: string, invitationId: string): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${slug}/invitations/${invitationId}/resend`)
    .set('Authorization', `Bearer ${bearer}`)
}

/**
 * Whether an invitation is still pending under its original link: not
 * revoked, not accepted, and its token hash unchanged (a resend replaces it).
 */
async function isStillPending(invitationId: string, rawToken: string): Promise<boolean> {
  const [row] = await sql<{ untouched: boolean }[]>`
    select revoked_at is null and accepted_at is null and token_hash = ${hashToken(rawToken)}
      as untouched
    from tenant_invitations where id = ${invitationId}`
  return row?.untouched === true
}

describe('invitations API', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user named Ada Lovelace with a bearer token, tracked for cleanup.
   * @param options - Whether the address is verified, and an explicit address.
   * @param options.verified - Set `emailVerifiedAt` to now. Defaults to true.
   * @param options.email - The address. Defaults to a unique one.
   */
  async function createUser(
    options: { verified?: boolean; email?: string } = {}
  ): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: options.email ?? uniqueEmail(),
      firstName: 'Ada',
      lastName: 'Lovelace',
      ...(options.verified !== false && { emailVerifiedAt: new Date() }),
    })
    createdUserIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID()) }
  }

  /**
   * A tenant named Acme Inc owned by `ownerId`, tracked for cleanup.
   */
  async function createTenant(ownerId: string): Promise<Tenant> {
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId,
    })
    createdTenantIds.push(tenant.id)
    return tenant
  }

  /**
   * An owner with a bearer token, and their tenant.
   */
  async function setup(): Promise<{ owner: User; ownerToken: string; tenant: Tenant }> {
    const { user: owner, token: ownerToken } = await createUser()
    const tenant = await createTenant(owner.id)
    return { owner, ownerToken, tenant }
  }

  /**
   * A tenant with one pending invitation, and two callers with no
   * membership in it: a signed-in stranger and another tenant's owner.
   */
  async function outsiders(): Promise<{
    tenant: Tenant
    invitationId: string
    rawToken: string
    tokens: [string, string]
  }> {
    const { owner, tenant } = await setup()
    const { invitationId, rawToken } = await seedInvitation(tenant, owner, {
      email: uniqueEmail(),
    })
    const { token: strangerToken } = await createUser()
    const { user: otherOwner, token: otherOwnerToken } = await createUser()
    await createTenant(otherOwner.id)
    return { tenant, invitationId, rawToken, tokens: [strangerToken, otherOwnerToken] }
  }

  describe('POST /api/v1/tenants/:slug/invitations', () => {
    it('answers a registered and an unregistered address with the identical 202 body', async () => {
      const { ownerToken, tenant } = await setup()
      const { user: registered } = await createUser()

      const forRegistered = await inviteVia(tenant.slug, ownerToken, {
        email: registered.email,
        role: 'viewer',
      })
      const forUnregistered = await inviteVia(tenant.slug, ownerToken, {
        email: uniqueEmail(),
        role: 'viewer',
      })

      expect(forRegistered.status).toBe(202)
      expect(forUnregistered.status).toBe(202)
      expect(forRegistered.body).toStrictEqual(INVITATION_SENT)
      expect(forUnregistered.body).toStrictEqual(forRegistered.body)
      expect(forUnregistered.text).toBe(forRegistered.text)
    })

    it.each([
      ['a verified existing user', 'verified', true],
      ['an unverified existing user', 'unverified', false],
      ['an unregistered address', 'unregistered', false],
    ] as const)(
      'mails %s with the invitation template, and notifies in-app only a verified user',
      async (_label, kind, isNotified) => {
        const { ownerToken, tenant } = await setup()
        const created =
          kind === 'unregistered' ? undefined : await createUser({ verified: kind === 'verified' })
        const invitee = created?.user
        const email = invitee?.email ?? uniqueEmail()

        await inviteVia(tenant.slug, ownerToken, { email, role: 'viewer' })

        const queued = await waitForInvitationEmail(email)
        expect(queued.userId).toBe(invitee?.id ?? '')
        const [pending] = await pendingOf(tenant.id)
        /**
         * Matches the notification job for this test's pending invitation.
         */
        const isThisNotification = (data: NotificationJobData): boolean =>
          data.type === 'tenant_invitation' && data.metadata?.invitationId === pending?.id
        if (isNotified) {
          const job = await waitForJob(getNotificationQueue(), isThisNotification)
          expect(JSON.stringify(job.data)).not.toContain(queued.token)
        } else {
          await expectNoJob(getNotificationQueue(), isThisNotification)
        }
      }
    )

    it('409s already_member for a current member', async () => {
      const { ownerToken, tenant } = await setup()
      const { user: member } = await createUser()
      await userMembershipRepository.create({
        userId: member.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const response = await inviteVia(tenant.slug, ownerToken, {
        email: member.email,
        role: 'editor',
      })

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({
        success: false,
        statusCode: 409,
        code: 'already_member',
        message: 'That person is already a member of this workspace. No invitation was sent.',
      })
    })

    it('lets an owner offer admin, and an admin offer a non-elevated role', async () => {
      const { ownerToken, tenant } = await setup()
      const { user: admin, token: adminToken } = await createUser()
      await userMembershipRepository.create({
        userId: admin.id,
        tenantId: tenant.id,
        role: 'admin',
      })

      const byOwner = await inviteVia(tenant.slug, ownerToken, {
        email: uniqueEmail(),
        role: 'admin',
      })
      const byAdmin = await inviteVia(tenant.slug, adminToken, {
        email: uniqueEmail(),
        role: 'manager',
      })

      expect(byOwner.status).toBe(202)
      expect(byAdmin.status).toBe(202)
    })

    it.each<MembershipRole>(['admin', 'owner'])(
      'blocks an admin from offering the %s role, and records nothing',
      async (role) => {
        const { tenant } = await setup()
        const { user: admin, token: adminToken } = await createUser()
        await userMembershipRepository.create({
          userId: admin.id,
          tenantId: tenant.id,
          role: 'admin',
        })

        const response = await inviteVia(tenant.slug, adminToken, { email: uniqueEmail(), role })

        expect(response.status).toBe(403)
        expect(await pendingOf(tenant.id)).toEqual([])
      }
    )

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])('403s a %s', async (role) => {
      const { tenant } = await setup()
      const { user: member, token: memberToken } = await createUser()
      await userMembershipRepository.create({ userId: member.id, tenantId: tenant.id, role })

      const response = await inviteVia(tenant.slug, memberToken, {
        email: uniqueEmail(),
        role: 'viewer',
      })

      expect(response.status).toBe(403)
    })

    it('404s a non-member', async () => {
      const { tenant } = await setup()
      const { token: outsiderToken } = await createUser()

      const response = await inviteVia(tenant.slug, outsiderToken, {
        email: uniqueEmail(),
        role: 'viewer',
      })

      expect(response.status).toBe(404)
    })

    it('400s an invalid address', async () => {
      const { ownerToken, tenant } = await setup()

      const response = await inviteVia(tenant.slug, ownerToken, {
        email: 'not-an-email',
        role: 'viewer',
      })

      expect(response.status).toBe(400)
    })

    // Each passes z.email() but its domain is no hostname: a bad label, a label over 63 characters, a domain over 253.
    it.each([
      ['a label ending in a hyphen', 'invitee@foo-.com'],
      ['a 64-character label', `invitee@${'a'.repeat(64)}.com`],
      [
        'a 259-character domain',
        `invitee@${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}.com`,
      ],
    ])('400s an address whose domain is %s', async (_label, email) => {
      const { ownerToken, tenant } = await setup()

      const response = await inviteVia(tenant.slug, ownerToken, { email, role: 'viewer' })

      expect(response.status).toBe(400)
      const body = response.body as { errors?: Record<string, unknown> }
      expect(body.errors).toHaveProperty('email')
    })
  })

  describe('GET /api/v1/tenants/:slug/invitations', () => {
    it('lists pending invitations with no token or token hash anywhere in the body', async () => {
      const { owner, ownerToken, tenant } = await setup()
      const email = uniqueEmail()
      await inviteVia(tenant.slug, ownerToken, { email, role: 'editor' })
      const { token: rawToken } = await waitForInvitationEmail(email)

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(response.status).toBe(200)
      const items =
        envelopeOf<{ items: Array<Record<string, unknown>> }>(response).data?.items ?? []
      expect(items).toHaveLength(1)
      expect(Object.keys(items[0] ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'invitedBy',
        'lastSentAt',
        'resendAvailableAt',
        'role',
      ])
      expect(items[0]).toMatchObject({
        email,
        role: 'editor',
        invitedBy: { id: owner.id, firstName: 'Ada', lastName: 'Lovelace' },
      })
      const body = JSON.stringify(response.body)
      expect(body).not.toContain(rawToken)
      expect(body).not.toContain(hashToken(rawToken))
    })

    it('lets an admin list them', async () => {
      const { owner, tenant } = await setup()
      const { user: admin, token: adminToken } = await createUser()
      await userMembershipRepository.create({
        userId: admin.id,
        tenantId: tenant.id,
        role: 'admin',
      })
      const { invitationId } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/invitations`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(response.status).toBe(200)
      const items = envelopeOf<{ items: Array<{ id: string }> }>(response).data?.items ?? []
      expect(items.map((item) => item.id)).toEqual([invitationId])
    })

    it('403s a viewer', async () => {
      const { tenant } = await setup()
      const { user: viewer, token: viewerToken } = await createUser()
      await userMembershipRepository.create({
        userId: viewer.id,
        tenantId: tenant.id,
        role: 'viewer',
      })

      const response = await request(app)
        .get(`/api/v1/tenants/${tenant.slug}/invitations`)
        .set('Authorization', `Bearer ${viewerToken}`)

      expect(response.status).toBe(403)
    })
  })

  describe('POST /api/v1/tenants/:slug/invitations/:id/resend', () => {
    it('kills the old link and mails a working new one', async () => {
      const { ownerToken, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      await inviteVia(tenant.slug, ownerToken, { email: invitee.email, role: 'viewer' })
      const first = await waitForInvitationEmail(invitee.email)
      const [pending] = await pendingOf(tenant.id)
      await backdateInvitationSend(pending?.id ?? '')

      // No .send(): the React client resends with no body at all.
      const resent = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/${pending?.id ?? ''}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(resent.status).toBe(202)
      expect(resent.body).toStrictEqual(INVITATION_SENT)
      const second = await waitForInvitationEmail(invitee.email, [first.token])
      const oldPreview = await previewVia(first.token)
      const oldAccept = await acceptVia(first.token, inviteeToken)
      const newPreview = await previewVia(second.token)
      expect(oldPreview.body).toMatchObject(INVALID)
      expect(oldAccept.body).toMatchObject(INVALID)
      expect(newPreview.status).toBe(200)
    })

    it('spends the same limiter budget as invite', async () => {
      const { ownerToken, tenant } = await setup()
      const invited = await inviteVia(tenant.slug, ownerToken, {
        email: uniqueEmail(),
        role: 'viewer',
      })
      const [pending] = await pendingOf(tenant.id)
      await backdateInvitationSend(pending?.id ?? '')

      const resent = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/${pending?.id ?? ''}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(resent.status).toBe(202)
      expect(Number(resent.headers['ratelimit-remaining'])).toBe(
        Number(invited.headers['ratelimit-remaining']) - 1
      )
    })

    it.each<MembershipRole>(['owner', 'admin'])(
      'blocks an admin from resending an %s-role invitation, and the link survives',
      async (role) => {
        const { owner, tenant } = await setup()
        const { user: admin, token: adminToken } = await createUser()
        await userMembershipRepository.create({
          userId: admin.id,
          tenantId: tenant.id,
          role: 'admin',
        })
        const { rawToken, invitationId } = await seedInvitation(tenant, owner, {
          email: uniqueEmail(),
          role,
        })

        const response = await request(app)
          .post(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}/resend`)
          .set('Authorization', `Bearer ${adminToken}`)

        expect(response.status).toBe(403)
        const survivor = await previewVia(rawToken)
        expect(survivor.status).toBe(200)
      }
    )

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      '403s a %s, and the link survives',
      async (role) => {
        const { owner, tenant } = await setup()
        const { user: member, token: memberToken } = await createUser()
        await userMembershipRepository.create({ userId: member.id, tenantId: tenant.id, role })
        const { rawToken, invitationId } = await seedInvitation(tenant, owner, {
          email: uniqueEmail(),
        })

        const response = await request(app)
          .post(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}/resend`)
          .set('Authorization', `Bearer ${memberToken}`)

        expect(response.status).toBe(403)
        const survivor = await previewVia(rawToken)
        expect(survivor.status).toBe(200)
      }
    )

    it('404s an unknown invitation and 400s a malformed id', async () => {
      const { ownerToken, tenant } = await setup()

      const unknown = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/${randomUUID()}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)
      const malformed = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/not-a-uuid/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ code: 'invitation_not_found' })
      expect(malformed.status).toBe(400)
      expect(malformed.body).toMatchObject({
        message: 'Check the highlighted fields, then try again.',
      })
    })
  })

  describe('mail per invitation and per recipient', () => {
    it('SEC-abuse-02: back-to-back resends of one invitation do not each mail the invitee', async () => {
      const { ownerToken, tenant } = await setup()
      const invitee = uniqueEmail()

      const invited = await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
      expect(invited.status).toBe(202)
      const [pending] = await pendingOf(tenant.id)
      for (let index = 0; index < 5; index += 1) {
        await resendVia(tenant.slug, ownerToken, pending?.id ?? '')
      }

      // The invite only: every resend lands inside the cooldown.
      expect(await trackedMailCount(invitee, 'tenant_invitation')).toBe(1)
    })

    it('answers a resend inside the cooldown 429 invitation_resend_cooldown, and the link keeps working', async () => {
      const { ownerToken, tenant } = await setup()
      const invitee = uniqueEmail()
      await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
      const { token: rawToken } = await waitForInvitationEmail(invitee)
      const [pending] = await pendingOf(tenant.id)

      const resent = await resendVia(tenant.slug, ownerToken, pending?.id ?? '')

      expect(resent.status).toBe(429)
      expect(resent.body).toMatchObject({
        code: 'invitation_resend_cooldown',
        message: 'You can resend this invitation in 10 minutes.',
      })
      const stillValid = await previewVia(rawToken)
      expect(stillValid.status).toBe(200)
    })

    it('reports resendAvailableAt inside the cooldown and null after it', async () => {
      const { ownerToken, tenant } = await setup()
      await inviteVia(tenant.slug, ownerToken, { email: uniqueEmail(), role: 'viewer' })
      const cooldownMs = requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN)

      const inside = await listVia(tenant.slug, ownerToken)
      const [fresh] = inside.items
      expect(typeof fresh?.lastSentAt).toBe('string')
      expect(Date.parse(fresh?.resendAvailableAt ?? '')).toBe(
        Date.parse(fresh?.lastSentAt ?? '') + cooldownMs
      )

      await backdateInvitationSend(fresh?.id ?? '')
      const after = await listVia(tenant.slug, ownerToken)
      const [sent] = after.items
      // oxlint-disable-next-line unicorn/no-null -- JSON null: the cooldown is over
      expect(sent).toMatchObject({ resendAvailableAt: null })
      expect(typeof sent?.lastSentAt).toBe('string')
    })

    it('answers the early resend 429 invitation_resend_cooldown with Retry-After of the seconds left', async () => {
      const { ownerToken, tenant } = await setup()
      await inviteVia(tenant.slug, ownerToken, { email: uniqueEmail(), role: 'viewer' })
      const { items } = await listVia(tenant.slug, ownerToken)
      const [pending] = items
      const cooldownSeconds = requireDurationMs(getEnv().INVITATION_RESEND_COOLDOWN) / 1000

      const resent = await resendVia(tenant.slug, ownerToken, pending?.id ?? '')

      expect(resent.status).toBe(429)
      const retryAfter = Number(resent.headers['retry-after'])
      expect(retryAfter).toBeGreaterThanOrEqual(1)
      expect(retryAfter).toBeLessThanOrEqual(cooldownSeconds)
      const secondsLeft = (Date.parse(pending?.resendAvailableAt ?? '') - Date.now()) / 1000
      expect(Math.abs(retryAfter - secondsLeft)).toBeLessThanOrEqual(2)
    })

    it('exposes Retry-After to the browser', async () => {
      const { ownerToken, tenant } = await setup()
      await inviteVia(tenant.slug, ownerToken, { email: uniqueEmail(), role: 'viewer' })
      const { items } = await listVia(tenant.slug, ownerToken)
      const [pending] = items

      const resent = await request(app)
        .post(`/api/v1/tenants/${tenant.slug}/invitations/${pending?.id ?? ''}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Origin', allowedOrigin)

      expect(resent.headers['access-control-expose-headers']).toContain('Retry-After')
    })

    it('resends once the cooldown has passed', async () => {
      const { ownerToken, tenant } = await setup()
      await inviteVia(tenant.slug, ownerToken, { email: uniqueEmail(), role: 'viewer' })
      const [pending] = await pendingOf(tenant.id)
      await backdateInvitationSend(pending?.id ?? '')

      const resent = await resendVia(tenant.slug, ownerToken, pending?.id ?? '')

      expect(resent.status).toBe(202)
    })

    it('refuses a resend whose invitation was sent again between the cooldown check and the token swap', async () => {
      const { ownerToken, tenant } = await setup()
      const invitee = uniqueEmail()
      await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
      const { token: rawToken } = await waitForInvitationEmail(invitee)
      const [pending] = await pendingOf(tenant.id)
      const invitationId = pending?.id ?? ''
      await backdateInvitationSend(invitationId)
      // oxlint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realFind = TenantInvitationRepository.prototype.findPendingById
      /**
       * Reads the pending invitation, then stamps a newer send time on it, as a resend landing
       * after the read would.
       */
      const findThenRace: TenantInvitationRepository['findPendingById'] = async function (
        this: TenantInvitationRepository,
        ...arguments_
      ) {
        const found = await realFind.apply(this, arguments_)
        await sql`update tenant_invitations set last_sent_at = clock_timestamp() where id = ${invitationId}`
        return found
      }

      let resent: Response | undefined
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'findPendingById',
        findThenRace,
        async () => {
          resent = await resendVia(tenant.slug, ownerToken, invitationId)
        }
      )

      expect(resent?.status).toBe(429)
      expect(resent?.body).toMatchObject({ code: 'invitation_resend_cooldown' })
      expect(Number(resent?.headers['retry-after'])).toBeGreaterThanOrEqual(1)
      const stillValid = await previewVia(rawToken)
      expect(stillValid.status).toBe(200)
    })

    it('refuses the eleventh invitation to one address within a day 429 RATE_LIMITED, whoever sends it', async () => {
      const invitee = uniqueEmail()
      for (let index = 0; index < 10; index += 1) {
        const { ownerToken, tenant } = await setup()
        const invited = await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
        expect(invited.status).toBe(202)
      }
      const { ownerToken, tenant } = await setup()

      const refused = await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })

      expect(refused.status).toBe(429)
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' })
      expect(await pendingOf(tenant.id)).toEqual([])
    })

    it('refuses a fourth invitation of one address from one tenant without spending its daily budget', async () => {
      const invitee = uniqueEmail()
      const { ownerToken, tenant } = await setup()
      for (let index = 0; index < 3; index += 1) {
        const invited = await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
        expect(invited.status).toBe(202)
      }
      const spentBefore = await recipientBudgetSpent(invitee)

      const refused = await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })

      expect(refused.status).toBe(429)
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' })
      expect(await recipientBudgetSpent(invitee)).toBe(spentBefore)
      const other = await setup()
      const elsewhere = await inviteVia(other.tenant.slug, other.ownerToken, {
        email: invitee,
        role: 'viewer',
      })
      expect(elsewhere.status).toBe(202)
    })

    it('refuses a resend past the address ceiling 429 RATE_LIMITED, and the link keeps working', async () => {
      const { ownerToken, tenant } = await setup()
      const invitee = uniqueEmail()
      await inviteVia(tenant.slug, ownerToken, { email: invitee, role: 'viewer' })
      const { token: rawToken } = await waitForInvitationEmail(invitee)
      const [pending] = await pendingOf(tenant.id)
      await backdateInvitationSend(pending?.id ?? '')
      const redis = await getRedis()
      await redis.set(
        recipientBudgetKey(invitee),
        String(getEnv().INVITATION_RECIPIENT_DAILY_LIMIT),
        { expiration: { type: 'PX', value: HOUR_MS } }
      )

      const resent = await resendVia(tenant.slug, ownerToken, pending?.id ?? '')

      expect(resent.status).toBe(429)
      expect(resent.body).toMatchObject({ code: 'RATE_LIMITED' })
      const stillValid = await previewVia(rawToken)
      expect(stillValid.status).toBe(200)
    })

    it('invites twelve distinct addresses back to back', async () => {
      const { ownerToken, tenant } = await setup()

      for (let index = 0; index < 12; index += 1) {
        const invited = await inviteVia(tenant.slug, ownerToken, {
          email: uniqueEmail(),
          role: 'viewer',
        })
        expect(invited.status).toBe(202)
      }

      expect(await pendingOf(tenant.id)).toHaveLength(12)
    })
  })

  describe('DELETE /api/v1/tenants/:slug/invitations/:id', () => {
    it('400s a malformed id, not 404', async () => {
      const { ownerToken, tenant } = await setup()

      const malformed = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/not-a-uuid`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(malformed.status).toBe(400)
      expect(malformed.body).toMatchObject({
        message: 'Check the highlighted fields, then try again.',
      })
    })

    it.each<MembershipRole>(['manager', 'editor', 'viewer'])(
      '403s a %s, and the link survives',
      async (role) => {
        const { owner, tenant } = await setup()
        const { user: member, token: memberToken } = await createUser()
        await userMembershipRepository.create({ userId: member.id, tenantId: tenant.id, role })
        const { rawToken, invitationId } = await seedInvitation(tenant, owner, {
          email: uniqueEmail(),
        })

        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
          .set('Authorization', `Bearer ${memberToken}`)

        expect(response.status).toBe(403)
        const survivor = await previewVia(rawToken)
        expect(survivor.status).toBe(200)
      }
    )

    // Revoke applies the grant rule, as invite and resend do.
    it.each(['owner', 'admin'] as const satisfies readonly MembershipRole[])(
      'refuses a tenant admin revoking an %s invitation 403',
      async (role) => {
        const { owner, tenant } = await setup()
        const { user: admin, token: adminToken } = await createUser()
        await userMembershipRepository.create({
          userId: admin.id,
          tenantId: tenant.id,
          role: 'admin',
        })
        const { invitationId } = await seedInvitation(tenant, owner, { email: uniqueEmail(), role })

        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({})

        expect(response.status).toBe(403)
        const [row] = await sql<{ revoked: boolean }[]>`
          select revoked_at is not null as revoked from tenant_invitations where id = ${invitationId}`
        expect(row?.revoked).toBe(false)
      }
    )

    it('lets a tenant admin revoke a manager invitation', async () => {
      const { owner, tenant } = await setup()
      const { user: admin, token: adminToken } = await createUser()
      await userMembershipRepository.create({
        userId: admin.id,
        tenantId: tenant.id,
        role: 'admin',
      })
      const { invitationId } = await seedInvitation(tenant, owner, {
        email: uniqueEmail(),
        role: 'manager',
      })

      const response = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})

      expect(response.status).toBe(200)
    })

    it('revokes: the link stops previewing and accepting, and a second revoke 404s', async () => {
      const { owner, ownerToken, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken, invitationId } = await seedInvitation(tenant, owner, {
        email: invitee.email,
      })

      const revoked = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(revoked.status).toBe(200)
      expect(revoked.body).toMatchObject({
        success: true,
        message: 'Invitation revoked.',
        // oxlint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
        data: null,
      })
      const revokedPreview = await previewVia(rawToken)
      const revokedAccept = await acceptVia(rawToken, inviteeToken)
      expect(revokedPreview.body).toMatchObject(INVALID)
      expect(revokedAccept.body).toMatchObject(INVALID)
      const again = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
      expect(again.status).toBe(404)
    })
  })

  describe('a caller outside the tenant', () => {
    it('404s GET /tenants/:slug/invitations for a non-member and for another tenant’s owner', async () => {
      const { tenant, tokens } = await outsiders()
      for (const token of tokens) {
        const response = await request(app)
          .get(`/api/v1/tenants/${tenant.slug}/invitations`)
          .set('Authorization', `Bearer ${token}`)
        expect(response.status).toBe(404)
        expect(envelopeOf(response).message).toBe(NOT_FOUND.tenant.message)
      }
    })

    it('404s POST /tenants/:slug/invitations for a non-member and for another tenant’s owner, creating nothing', async () => {
      const { tenant, tokens } = await outsiders()
      const email = uniqueEmail()
      for (const token of tokens) {
        const response = await inviteVia(tenant.slug, token, { email, role: 'viewer' })
        expect(response.status).toBe(404)
        expect(envelopeOf(response).message).toBe(NOT_FOUND.tenant.message)
      }
      expect(
        await sql`select 1 from tenant_invitations where tenant_id = ${tenant.id} and email = ${email}`
      ).toHaveLength(0)
    })

    it('404s POST /tenants/:slug/invitations/:id/resend for a non-member, leaving the invitation alone', async () => {
      const { tenant, invitationId, rawToken, tokens } = await outsiders()
      // Past the resend cooldown, so only the tenant gate can refuse.
      await backdateInvitationSend(invitationId)
      for (const token of tokens) {
        const response = await request(app)
          .post(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}/resend`)
          .set('Authorization', `Bearer ${token}`)
        expect(response.status).toBe(404)
        expect(envelopeOf(response).message).toBe(NOT_FOUND.tenant.message)
      }
      expect(await isStillPending(invitationId, rawToken)).toBe(true)
    })

    it('404s DELETE /tenants/:slug/invitations/:id for a non-member, leaving the invitation pending', async () => {
      const { tenant, invitationId, rawToken, tokens } = await outsiders()
      for (const token of tokens) {
        const response = await request(app)
          .delete(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}`)
          .set('Authorization', `Bearer ${token}`)
        expect(response.status).toBe(404)
        expect(envelopeOf(response).message).toBe(NOT_FOUND.tenant.message)
      }
      expect(await isStillPending(invitationId, rawToken)).toBe(true)
    })
  })

  describe('POST /api/v1/invitations/preview', () => {
    it('has no GET form: a token never travels in an API URL', async () => {
      const { owner, tenant } = await setup()
      const { rawToken } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      const response = await request(app)
        .get('/api/v1/invitations/preview')
        .query({ token: rawToken })

      expect(response.status).toBe(404)
      expect(response.body).not.toMatchObject({ code: 'invitation_invalid' })
    })

    it('shows a valid invitation without signing in, behind a limiter', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      const { rawToken } = await seedInvitation(tenant, owner, { email })

      const response = await previewVia(rawToken)

      expect(response.status).toBe(200)
      expect(envelopeOf(response).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        invitedBy: { firstName: 'Ada', lastName: 'Lovelace' },
        email,
      })
      expect(response.headers).toHaveProperty('ratelimit-limit')
    })

    it('answers invitation_invalid for an expired invitation', async () => {
      const { owner, tenant } = await setup()
      const { rawToken } = await seedInvitation(tenant, owner, {
        email: uniqueEmail(),
        expiresAt: new Date(Date.now() - 1000),
      })

      const response = await previewVia(rawToken)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
    })

    it('answers a malformed token exactly like an unknown well-formed one', async () => {
      const unknown = await previewVia(randomBytes(32).toString('base64url'))
      const malformed = await previewVia('not-a-token')

      expect(unknown.body).toMatchObject(INVALID)
      expect(malformed.status).toBe(unknown.status)
      expect(malformed.body).toMatchObject(INVALID)
    })
  })

  describe('POST /api/v1/invitations/accept', () => {
    it('makes a verified invitee a member, behind a limiter', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const response = await acceptVia(rawToken, inviteeToken)

      expect(response.status).toBe(200)
      expect(envelopeOf(response).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        alreadyMember: false,
      })
      expect(response.headers).toHaveProperty('ratelimit-limit')
      const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      expect(membership?.role).toBe('editor')
      // A used link previews as invalid; the React page shows "invalid or expired".
      const usedPreview = await previewVia(rawToken)
      expect(usedPreview.body).toMatchObject(INVALID)
    })

    it('SEC-abuse-03: unauthenticated accept traffic from an address does not spend a signed-in invitee’s accept budget', async () => {
      const client = await getRedis()
      const keys: string[] = []
      const batches = client.scanIterator({
        MATCH: `${redisKey('rl', 'invitation-accept')}:*`,
        COUNT: 100,
      })
      for await (const batch of batches) {
        keys.push(...batch)
      }
      if (keys.length > 0) await client.del(keys)
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      for (let index = 0; index < 20; index += 1) {
        const junk = await acceptVia(randomBytes(32).toString('base64url'))
        expect(junk.status).toBe(401)
      }
      const accepted = await acceptVia(rawToken, inviteeToken)

      expect(accepted.status).toBe(200)
    })

    it('answers an unauthenticated form post 401 before the content-type gate', async () => {
      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .type('form')
        .send('token=x')

      expect(response.status).toBe(401)
      expect(response.headers).not.toHaveProperty('ratelimit-limit')
    })

    it('answers a malformed token with invitation_invalid', async () => {
      const { token } = await createUser()

      const response = await acceptVia('not-a-token', token)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
    })

    it('401s without a bearer token', async () => {
      const response = await acceptVia(randomBytes(32).toString('base64url'))

      expect(response.status).toBe(401)
    })

    it('403s an unverified account and leaves the invitation valid', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser({ verified: false })
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const response = await acceptVia(rawToken, inviteeToken)

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject(UNVERIFIED)
      const stillValid = await previewVia(rawToken)
      expect(stillValid.status).toBe(200)
    })

    it('403s a verified account with a different address', async () => {
      const { owner, tenant } = await setup()
      const { token: strangerToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: uniqueEmail() })

      const response = await acceptVia(rawToken, strangerToken)

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject(MISMATCH)
    })

    it('succeeds twice for the invitee, idempotently', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const first = await acceptVia(rawToken, inviteeToken)
      const second = await acceptVia(rawToken, inviteeToken)

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(envelopeOf(second).data).toStrictEqual({
        ...envelopeOf<Record<string, unknown>>(first).data,
        alreadyMember: true,
      })
    })

    it('answers alreadyMember false on the first accept', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })

      const response = await acceptVia(rawToken, inviteeToken)

      expect(response.status).toBe(200)
      expect(envelopeOf(response).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        alreadyMember: false,
      })
    })

    it('answers alreadyMember true when the invitee accepts a used link again', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await acceptVia(rawToken, inviteeToken)

      const again = await acceptVia(rawToken, inviteeToken)

      expect(again.status).toBe(200)
      expect(envelopeOf(again).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        alreadyMember: true,
      })
    })

    it('answers alreadyMember true to the invitee who joined through the confirm link', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { rawToken, invitationId } = await seedInvitation(tenant, owner, {
        email: invitee.email,
      })
      // The confirm link an invite click mails, minted directly: no Worker runs here.
      const { raw } = await issueLinkToken(
        { intent: 'invitation', email: invitee.email, app: 'web', invitationId },
        requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
      )
      const confirmed = await request(app).post('/api/v1/invitations/confirm').send({ token: raw })
      expect(confirmed.status).toBe(200)

      const again = await acceptVia(rawToken, inviteeToken)

      expect(again.status).toBe(200)
      expect(envelopeOf<{ alreadyMember: boolean }>(again).data?.alreadyMember).toBe(true)
    })

    it('still answers invitation_invalid to someone else holding a used link', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { token: otherToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await acceptVia(rawToken, inviteeToken)

      const response = await acceptVia(rawToken, otherToken)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
      expect(envelopeOf(response).data).toBeUndefined()
    })

    it('404s anyone else once the invitation is accepted', async () => {
      const { owner, tenant } = await setup()
      const { user: invitee, token: inviteeToken } = await createUser()
      const { token: otherToken } = await createUser()
      const { rawToken } = await seedInvitation(tenant, owner, { email: invitee.email })
      await acceptVia(rawToken, inviteeToken)

      const response = await acceptVia(rawToken, otherToken)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
    })
  })

  describe('an invitation to an unregistered address', () => {
    it('is accepted after the invitee signs up by a sign-in link', async () => {
      const { ownerToken, tenant } = await setup()
      const email = uniqueEmail()
      const invited = await inviteVia(tenant.slug, ownerToken, { email, role: 'editor' })
      expect(invited.status).toBe(202)
      const { token: invitationToken } = await waitForInvitationEmail(email)

      const { accessToken, userId } = await signInByLink(email)
      createdUserIds.push(userId)
      const user = await userRepository.findById(userId)
      if (!user) throw new Error('the sign-in link created no user')

      const accepted = await acceptVia(invitationToken, accessToken)

      expect(accepted.status).toBe(200)
      expect(envelopeOf(accepted).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
        alreadyMember: false,
      })
      const membership = await userMembershipRepository.findByUserAndTenant(user.id, tenant.id)
      expect(membership?.role).toBe('editor')
    })
  })

  describe('security', () => {
    it('never writes a raw token to the log on invite, preview or accept', async () => {
      const spies = (['error', 'warn', 'info', 'debug'] as const).map((level) =>
        vi.spyOn(logger, level)
      )
      try {
        const { ownerToken, tenant } = await setup()
        const { user: invitee, token: inviteeToken } = await createUser()
        await inviteVia(tenant.slug, ownerToken, { email: invitee.email, role: 'viewer' })
        const { token: rawToken } = await waitForInvitationEmail(invitee.email)
        await previewVia(rawToken)
        const afterPreview = inspect(
          spies.map((spy) => spy.mock.calls),
          { depth: Infinity }
        )
        expect(afterPreview).not.toContain(rawToken)
        await acceptVia(rawToken, inviteeToken)
        // A positive control: proves the spies capture what is logged.
        const marker = randomUUID()
        logger.info('invitation log-leak control', { marker })

        const logged = inspect(
          spies.map((spy) => spy.mock.calls),
          { depth: Infinity }
        )
        expect(logged).toContain(marker)
        expect(logged).not.toContain(rawToken)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })
})

/**
 * Invite `email` as `inviter` and return the raw token from the mail.
 */
async function inviteAs(
  slug: string,
  token: string,
  email: string,
  role: MembershipRole
): Promise<string> {
  const response = await inviteVia(slug, token, { email, role })
  expect(response.status).toBe(202)
  const mail = await waitForInvitationEmail(email)
  return mail.token
}

/**
 * Accept `rawToken` as a fresh verified account for `email`.
 */
async function acceptAs(rawToken: string, email: string): Promise<Response> {
  const invitee = await createTrackedUser({ email })
  return acceptVia(rawToken, tokenFor(invitee))
}

describe('an invitation outlives its sender', () => {
  const tenantIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
    tenantIds.length = 0
    await deleteTrackedUsers()
  })

  /**
   * A customer tenant with an owner and a second member holding `role`.
   */
  async function tenantWith(
    role: MembershipRole
  ): Promise<{ tenant: Tenant; owner: User; member: User }> {
    const owner = await createTrackedUser()
    const member = await createTrackedUser()
    const tenant = await tenantRepository.create({
      name: 'Sender Co',
      slug: `sender-${owner.id.slice(0, 8)}`,
      ownerId: owner.id,
    })
    tenantIds.push(tenant.id)
    await userMembershipRepository.create({ userId: member.id, tenantId: tenant.id, role })
    return { tenant, owner, member }
  }

  it('customer tenant: an admin is removed, then their manager invitation is accepted', async () => {
    const { tenant, owner, member: admin } = await tenantWith('admin')
    const email = `sender-${randomUUID()}@example.test`
    const rawToken = await inviteAs(tenant.slug, tokenFor(admin), email, 'manager')

    const removal = await request(app)
      .delete(`/api/v1/tenants/${tenant.slug}/members/${admin.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({})
    expect(removal.status).toBe(200)

    const accept = await acceptAs(rawToken, email)
    expect(accept.status).toBe(404)
    expect(envelopeOf(accept).code).toBe('invitation_invalid')
  })

  it('customer tenant: an admin is demoted to viewer, then their manager invitation is accepted', async () => {
    const { tenant, owner, member: admin } = await tenantWith('admin')
    const email = `sender-${randomUUID()}@example.test`
    const rawToken = await inviteAs(tenant.slug, tokenFor(admin), email, 'manager')

    const demotion = await request(app)
      .patch(`/api/v1/tenants/${tenant.slug}/members/${admin.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ role: 'viewer' })
    expect(demotion.status).toBe(200)

    const accept = await acceptAs(rawToken, email)
    expect(accept.status).toBe(404)
    expect(envelopeOf(accept).code).toBe('invitation_invalid')
  })

  it('platform tenant: a staff admin is removed, then their viewer invitation still mints staff', async () => {
    const platform = await platformTenant()
    const { user: staffAdmin, token: adminToken } = await createTrackedStaff('admin')
    const { user: staffOwner } = await createTrackedStaff('owner')
    const email = `sender-${randomUUID()}@example.test`
    const rawToken = await inviteAs(platform.slug, adminToken, email, 'viewer')

    const removal = await request(app)
      .delete(`/api/v1/tenants/${platform.slug}/members/${staffAdmin.id}`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(staffOwner)}`)
      .send({})
    expect(removal.status).toBe(200)

    const accept = await acceptAs(rawToken, email)
    expect(accept.status).toBe(404)
    expect(envelopeOf(accept).code).toBe('invitation_invalid')
  })

  it('customer tenant: a staff admin invites on platform access, is removed from staff, then the invitation is accepted', async () => {
    const platform = await platformTenant()
    const { tenant } = await tenantWith('viewer')
    const { user: staffAdmin } = await createTrackedStaff('admin')
    const { user: staffOwner } = await createTrackedStaff('owner')
    const email = `sender-${randomUUID()}@example.test`
    // Staff inviting on a customer tenant need a recent sign-in and a reason.
    const invited = await inviteVia(tenant.slug, recentAuthTokenFor(staffAdmin), {
      email,
      role: 'manager',
      reason: 'Customer asked us to, ticket 4411',
    })
    expect(invited.status).toBe(202)
    const { token: rawToken } = await waitForInvitationEmail(email)

    const removal = await request(app)
      .delete(`/api/v1/tenants/${platform.slug}/members/${staffAdmin.id}`)
      .set('Authorization', `Bearer ${recentAuthTokenFor(staffOwner)}`)
      .send({})
    expect(removal.status).toBe(200)

    const accept = await acceptAs(rawToken, email)
    expect(accept.status).toBe(404)
    expect(envelopeOf(accept).code).toBe('invitation_invalid')
  })
})
