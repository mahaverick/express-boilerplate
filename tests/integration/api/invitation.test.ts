// tests/integration/api/invitation.test.ts
//
// The invitation endpoints end to end, against the real per-worker Postgres
// and Redis. No Worker runs: tests read the invitation and verification
// emails straight off the queues (tests/helpers/queue-jobs.ts).
//
// RATE LIMITS are wiring, not thresholds. The preview (60 per 15 min) and
// accept (20 per 15 min) limiters are keyed on IP, and every request here
// comes from 127.0.0.1. This file makes 13 accept and 18 preview requests;
// keep accepts under 20 or the file throttles itself. Thresholds are proven
// with small overrides in tests/unit/middlewares/rate-limit.middleware.test.ts.
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import type { NotificationJobData } from '@/jobs/notification.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { hashToken, signAccessToken } from '@/utilities/token.utilities'
import {
  expectNoJob,
  waitForInvitationEmail,
  waitForJob,
  waitForVerificationToken,
} from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const HOUR_MS = 60 * 60 * 1000
const PASSWORD = 'correct horse battery staple'
const INVITATION_SENT = {
  success: true,
  message: 'If that address can be invited, an invitation has been sent.',
  statusCode: 202,
  // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
  data: null,
}
const INVALID = {
  success: false,
  statusCode: 404,
  code: 'invitation_invalid',
  message: 'This invitation is invalid or has expired.',
}
const UNVERIFIED = {
  success: false,
  statusCode: 403,
  code: 'invitation_email_unverified',
  message: 'Verify your email address before accepting this invitation.',
}
const MISMATCH = {
  success: false,
  statusCode: 403,
  code: 'invitation_email_mismatch',
  message: 'This invitation was sent to a different email address.',
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
 * Cast a supertest body to a known envelope shape.
 * @param response - The supertest response.
 * @returns The body, typed.
 */
function envelopeOf<TData>(response: Response): ApiEnvelope<TData> {
  return response.body as ApiEnvelope<TData>
}

/**
 * A disposable email, unique to one call.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `invitation-api-${randomUUID()}@example.test`
}

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * Write an invitation with a known raw token, bypassing the API.
 * @param tenant - The tenant.
 * @param inviter - The inviter.
 * @param options - Address, role and expiry.
 * @param options.email - The invited address.
 * @param options.role - The offered role. Defaults to editor.
 * @param options.expiresAt - The expiry. Defaults to an hour from now.
 * @returns The raw token and the invitation id.
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
 * @param slug - The tenant slug.
 * @param bearer - The caller's access token.
 * @param body - The request body.
 * @returns The response.
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
 * @returns The response.
 */
async function previewVia(token: string): Promise<Response> {
  return request(app).post('/api/v1/invitations/preview').send({ token })
}

/**
 * POST an accept, optionally signed in.
 * @param token - The raw token.
 * @param bearer - The caller's access token, if any.
 * @returns The response.
 */
async function acceptVia(token: string, bearer?: string): Promise<Response> {
  const pending = request(app).post('/api/v1/invitations/accept')
  if (bearer) pending.set('Authorization', `Bearer ${bearer}`)
  return pending.send({ token })
}

describe('invitations API', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
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
   * @returns The user and a valid bearer token for them.
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
   * @param ownerId - The owner.
   * @returns The tenant.
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
   * @returns The owner, their token, and the tenant.
   */
  async function setup(): Promise<{ owner: User; ownerToken: string; tenant: Tenant }> {
    const { user: owner, token: ownerToken } = await createUser()
    const tenant = await createTenant(owner.id)
    return { owner, ownerToken, tenant }
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
        const [pending] = await invitationRepository.listPending(tenant.id)
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
        message: 'That person is already a member.',
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
        expect(await invitationRepository.listPending(tenant.id)).toEqual([])
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
      const items = envelopeOf<Array<Record<string, unknown>>>(response).data ?? []
      expect(items).toHaveLength(1)
      expect(Object.keys(items[0] ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'createdAt',
        'email',
        'expiresAt',
        'id',
        'invitedBy',
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
      const items = envelopeOf<Array<{ id: string }>>(response).data ?? []
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
      const [pending] = await invitationRepository.listPending(tenant.id)

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
      const [pending] = await invitationRepository.listPending(tenant.id)

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
      expect(malformed.body).toMatchObject({ message: 'Validation failed' })
    })
  })

  describe('DELETE /api/v1/tenants/:slug/invitations/:id', () => {
    it('400s a malformed id, not 404', async () => {
      const { ownerToken, tenant } = await setup()

      const malformed = await request(app)
        .delete(`/api/v1/tenants/${tenant.slug}/invitations/not-a-uuid`)
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(malformed.status).toBe(400)
      expect(malformed.body).toMatchObject({ message: 'Validation failed' })
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
        // eslint-disable-next-line unicorn/no-null -- the API envelope uses JSON null for "no data"
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
      })
      expect(response.headers).toHaveProperty('ratelimit-limit')
      const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      expect(membership?.role).toBe('editor')
      // A used link previews as invalid; the React page shows "invalid or expired".
      const usedPreview = await previewVia(rawToken)
      expect(usedPreview.body).toMatchObject(INVALID)
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
      expect(envelopeOf(second).data).toStrictEqual(envelopeOf(first).data)
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
    it('is accepted after the invitee registers, verifies and logs in', async () => {
      const { ownerToken, tenant } = await setup()
      const email = uniqueEmail()
      const invited = await inviteVia(tenant.slug, ownerToken, { email, role: 'editor' })
      expect(invited.status).toBe(202)
      const { token: invitationToken } = await waitForInvitationEmail(email)

      const registered = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: PASSWORD, firstName: 'Grace' })
      expect(registered.status).toBe(202)
      const user = await userRepository.findByEmail(email)
      if (!user) throw new Error('registration created no user')
      createdUserIds.push(user.id)

      const verificationToken = await waitForVerificationToken(user.id)
      const verified = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: verificationToken, password: PASSWORD })
      expect(verified.status).toBe(200)

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
      expect(login.status).toBe(200)
      const accessToken = envelopeOf<{ accessToken: string }>(login).data?.accessToken ?? ''

      const accepted = await acceptVia(invitationToken, accessToken)

      expect(accepted.status).toBe(200)
      expect(envelopeOf(accepted).data).toStrictEqual({
        tenant: { name: 'Acme Inc', slug: tenant.slug },
        role: 'editor',
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
