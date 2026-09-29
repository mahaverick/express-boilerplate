/**
 * @file POST /api/v1/platform/tenants and POST /platform/tenants/:id/owner-invitation:
 * staff create a tenant with no members and invite its owner.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import {
  INVITEE_DEACTIVATED_CODE,
  SLUG_TAKEN_CODE,
  type MembershipRole,
} from '@/constants/tenant.constants'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { reissueOwnerInvitation } from '@/services/platform-tenant.service'
import { closeQueue, getEmailQueue, getNotificationQueue } from '@/services/queue.service'
import { signAccessToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { waitForInvitationEmail } from '../../helpers/queue-jobs'
import { request } from '../../helpers/request'

interface CreatedBody {
  tenant: {
    id: string
    slug: string
    memberCount: number
    owners: unknown[]
    pendingOwnerInvitation: { email: string } | null
  }
  emailSent: boolean
}

const app = createApp()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

// The owner invitations this file queues must not linger under the worker's key prefix for the next file.
afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

function create(token: string, body: Record<string, unknown>): Promise<Response> {
  return request(app)
    .post('/api/v1/platform/tenants')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

function reissue(
  token: string,
  tenantId: string,
  email: string,
  body?: Record<string, unknown>
): Promise<Response> {
  return request(app)
    .post(`/api/v1/platform/tenants/${tenantId}/owner-invitation`)
    .set('Authorization', `Bearer ${token}`)
    .send({ email, ...(body ?? { reason: 'Customer asked us to resend' }) })
}

describe('staff-created tenants', () => {
  const userIds: string[] = []
  const slugs: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    if (slugs.length > 0) await sql`delete from tenants where slug = any(${slugs})`
    if (userIds.length > 0) await sql`delete from users where id = any(${userIds})`
    slugs.length = 0
    userIds.length = 0
  })

  async function createUser(isVerified = false): Promise<{ user: User; token: string }> {
    const user = await userRepository.create({
      email: `create-${randomUUID()}@example.test`,
      // eslint-disable-next-line unicorn/no-null -- the column is nullable; null is unverified
      emailVerifiedAt: isVerified ? new Date() : null,
    })
    userIds.push(user.id)
    return { user, token: signAccessToken(user, randomUUID(), new Date()) }
  }

  async function staff(role: MembershipRole): Promise<{ user: User; token: string }> {
    const created = await createUser(true)
    await makeStaff(created.user.id, role)
    return created
  }

  function newSlug(): string {
    const slug = `made-${randomUUID().slice(0, 8)}`
    slugs.push(slug)
    return slug
  }

  describe('POST /platform/tenants', () => {
    it('creates an ownerless tenant with settings and one pending owner invitation to WEB_URL', async () => {
      const { user: admin, token } = await staff('admin')
      const slug = newSlug()
      const ownerEmail = `Owner-${randomUUID()}@Example.test`

      const response = await create(token, {
        name: 'Made By Staff',
        slug,
        ownerEmail,
        website: 'https://made.test',
      })

      expect(response.status).toBe(201)
      const body = (response.body as { data: CreatedBody }).data
      expect(body.emailSent).toBe(true)
      expect(body.tenant).toMatchObject({ slug, memberCount: 0, owners: [] })
      expect(body.tenant.pendingOwnerInvitation?.email).toBe(ownerEmail.toLowerCase())

      const [invitation] =
        await sql`select role, invited_by from tenant_invitations where tenant_id = ${body.tenant.id}`
      expect(invitation).toMatchObject({ role: 'owner', invited_by: admin.id })
      const mail = await waitForInvitationEmail(ownerEmail.toLowerCase())
      expect(new URL(mail.variables.acceptUrl).origin).toBe(
        new URL(process.env.WEB_URL ?? '').origin
      )

      const audit = await sql<
        { action: string; access: string; actor_user_id: string; metadata: unknown }[]
      >`select action, access, actor_user_id, metadata from audit_logs where tenant_id = ${body.tenant.id} order by occurred_at, id`
      expect(audit.map((row) => row.action)).toEqual(['tenant.created', 'tenant.owner_invited'])
      expect(
        audit.every((row) => row.access === 'platform' && row.actor_user_id === admin.id)
      ).toBe(true)
      expect(audit[1]?.metadata).toEqual({
        emailDomain: 'example.test',
        // eslint-disable-next-line unicorn/no-null -- JSON null: the address has no account yet
        inviteeUserId: null,
        // eslint-disable-next-line unicorn/no-null -- JSON null: no reason is asked at creation
        reason: null,
      })
    })

    it('lets exactly one of two concurrent creates with the same slug win', async () => {
      const { token } = await staff('admin')
      const slug = newSlug()

      const [first, second] = await Promise.all([
        create(token, { name: 'Race A', slug, ownerEmail: `ra-${randomUUID()}@example.test` }),
        create(token, { name: 'Race B', slug, ownerEmail: `rb-${randomUUID()}@example.test` }),
      ])

      expect([first.status, second.status].toSorted((a, b) => a - b)).toEqual([201, 409])
      const rows = await sql`select id from tenants where slug = ${slug}`
      expect(rows).toHaveLength(1)
    })

    it('answers 409 when the owner address belongs to a deactivated account', async () => {
      const { token } = await staff('admin')
      const { user: inactive } = await createUser(true)
      await sql`update users set active = false where id = ${inactive.id}`

      const response = await create(token, {
        name: 'Blocked',
        slug: newSlug(),
        ownerEmail: inactive.email,
      })

      expect(response.status).toBe(409)
      expect(response.body as { message: string; code?: string }).toMatchObject({
        message: 'That account is deactivated',
        code: INVITEE_DEACTIVATED_CODE,
      })
    })

    it('does not make the staff creator a member', async () => {
      const { user: admin, token } = await staff('admin')
      const slug = newSlug()

      const response = await create(token, {
        name: 'No Member',
        slug,
        ownerEmail: `o-${randomUUID()}@example.test`,
      })

      const tenantId = (response.body as { data: CreatedBody }).data.tenant.id
      expect(await userMembershipRepository.findByUserAndTenant(admin.id, tenantId)).toBeUndefined()
    })

    it('answers 409 for a taken slug, and writes nothing', async () => {
      const { token } = await staff('admin')
      const slug = newSlug()
      await create(token, { name: 'First', slug, ownerEmail: `a-${randomUUID()}@example.test` })

      const second = await create(token, {
        name: 'Second',
        slug,
        ownerEmail: `b-${randomUUID()}@example.test`,
      })

      expect(second.status).toBe(409)
      expect((second.body as { code?: string }).code).toBe(SLUG_TAKEN_CODE)
      const rows = await sql<{ name: string }[]>`select name from tenants where slug = ${slug}`
      expect(rows.map((row) => row.name)).toEqual(['First'])
    })

    it.each([
      [{ name: 'X', slug: 'admin', ownerEmail: 'x@example.test' }, 'slug'],
      [{ name: 'X', slug: 'Bad Slug', ownerEmail: 'x@example.test' }, 'slug'],
      [{ name: 'X', slug: 'fine-slug', ownerEmail: 'not-an-email' }, 'ownerEmail'],
      [{ slug: 'fine-slug', ownerEmail: 'x@example.test' }, 'name'],
    ])('answers 400 for %j', async (body, field) => {
      const { token } = await staff('admin')

      const response = await create(token, body)

      expect(response.status).toBe(400)
      expect((response.body as { errors?: Record<string, unknown> }).errors).toHaveProperty(field)
    })

    it('answers 404 to a platform viewer', async () => {
      const { token } = await staff('viewer')

      const response = await create(token, {
        name: 'X',
        slug: newSlug(),
        ownerEmail: 'x@example.test',
      })
      expect(response.status).toBe(404)
    })

    it('lets the invited owner accept and become the sole owner', async () => {
      const { token } = await staff('admin')
      const { user: invitee, token: inviteeToken } = await createUser(true)
      const response = await create(token, {
        name: 'Accept Me',
        slug: newSlug(),
        ownerEmail: invitee.email,
      })
      const tenantId = (response.body as { data: CreatedBody }).data.tenant.id
      const mail = await waitForInvitationEmail(invitee.email)

      const accepted = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${inviteeToken}`)
        .send({ token: mail.token })

      expect(accepted.status).toBe(200)
      const result = await userMembershipRepository.findByUserAndTenant(invitee.id, tenantId)
      expect(result?.role).toBe('owner')
    })
  })

  describe('POST /platform/tenants/:id/owner-invitation', () => {
    it('revokes the pending owner invitation and sends a new one to the new address', async () => {
      const { token } = await staff('admin')
      const first = `first-${randomUUID()}@example.test`
      const second = `second-${randomUUID()}@example.test`
      const created = await create(token, { name: 'Reissue', slug: newSlug(), ownerEmail: first })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id

      const response = await reissue(token, tenantId, second)

      expect(response.status).toBe(200)
      expect((response.body as { data: { emailSent: boolean } }).data.emailSent).toBe(true)
      const pending = await sql<{ email: string }[]>`select email from tenant_invitations
        where tenant_id = ${tenantId} and accepted_at is null and revoked_at is null`
      expect(pending.map((row) => row.email)).toEqual([second])
      await waitForInvitationEmail(second)
      const actions = await sql<
        { action: string }[]
      >`select action from audit_logs where tenant_id = ${tenantId} order by occurred_at, id`
      expect(actions.map((row) => row.action)).toEqual([
        'tenant.created',
        'tenant.owner_invited',
        'invitation.revoked',
        'tenant.owner_invited',
      ])
    })

    it('answers 409 when the tenant already has an active owner', async () => {
      const { token } = await staff('admin')
      const { user: owner } = await createUser(true)
      const tenant = await tenantRepository.create({
        name: 'Owned',
        slug: newSlug(),
        ownerId: owner.id,
      })

      const response = await reissue(token, tenant.id, `x-${randomUUID()}@example.test`)

      expect(response.status).toBe(409)
      expect((response.body as { message: string }).message).toBe(
        'This tenant already has an owner; manage it from Members.'
      )
    })

    it('allows a re-issue when the only owner is deactivated, since nobody can act as owner', async () => {
      const { token } = await staff('admin')
      const { user: owner } = await createUser(true)
      const tenant = await tenantRepository.create({
        name: 'Stuck',
        slug: newSlug(),
        ownerId: owner.id,
      })
      await sql`update users set active = false where id = ${owner.id}`

      const response = await reissue(token, tenant.id, `new-${randomUUID()}@example.test`)
      expect(response.status).toBe(200)
    })

    it('allows a staff address, recording the invitee account and the reason', async () => {
      const { user: admin, token } = await staff('admin')
      const created = await create(token, {
        name: 'Self',
        slug: newSlug(),
        ownerEmail: `s-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id

      const response = await reissue(token, tenantId, admin.email)
      expect(response.status).toBe(200)

      const [row] = await sql`
        select metadata from audit_logs where tenant_id = ${tenantId} and action = 'tenant.owner_invited'
        order by occurred_at desc, id desc limit 1`
      expect(row?.metadata).toEqual({
        emailDomain: 'example.test',
        inviteeUserId: admin.id,
        reason: 'Customer asked us to resend',
      })
    })

    it('needs a reason and a recent sign-in', async () => {
      const { user: admin, token } = await staff('admin')
      const created = await create(token, {
        name: 'Gate',
        slug: newSlug(),
        ownerEmail: `g-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id

      const response = await reissue(token, tenantId, 'n@example.test', {})
      expect(response.status).toBe(400)
      const stale = await reissue(signAccessToken(admin, randomUUID()), tenantId, 'n@example.test')
      expect(stale.status).toBe(401)
      expect((stale.body as { code?: string }).code).toBe('REAUTH_REQUIRED')
    })

    it('answers 409 for a suspended tenant and for the platform tenant', async () => {
      const { token } = await staff('admin')
      const created = await create(token, {
        name: 'Frozen',
        slug: newSlug(),
        ownerEmail: `f-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id
      await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenantId}`
      const platform = await platformTenant()

      const response = await reissue(token, tenantId, 'y@example.test')
      expect(response.status).toBe(409)
      expect((response.body as { message: string }).message).toBe(
        'Cannot invite an owner to a suspended tenant.'
      )
      const response2 = await reissue(token, platform.id, 'y@example.test')
      expect(response2.status).toBe(409)
      expect((response2.body as { message: string }).message).toBe(
        'The platform tenant has no owner invitation; invite staff from Staff.'
      )
    })

    it('answers 409 for an archived tenant, before the transaction and inside it', async () => {
      const { user: admin, token } = await staff('admin')
      const created = await create(token, {
        name: 'Gone',
        slug: newSlug(),
        ownerEmail: `a-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id
      await sql`update tenants set lifecycle_state = 'archived', deleted_at = now() where id = ${tenantId}`

      const response = await reissue(token, tenantId, 'z@example.test')
      expect(response.status).toBe(409)
      expect((response.body as { message: string }).message).toBe(
        'Cannot invite an owner to an archived tenant.'
      )

      // Archived between the first read and the lock: the first read still sees it active.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately capturing the original to call it inside the mutated version
      const realFind = TenantRepository.prototype.findByIdIncludingDeleted
      let calls = 0
      const staleFirstRead: typeof realFind = async function (
        this: TenantRepository,
        ...arguments_
      ) {
        calls += 1
        const found = await realFind.apply(this, arguments_)
        if (calls !== 1 || !found) return found
        // eslint-disable-next-line unicorn/no-null -- the live row's deleted_at
        return { ...found, lifecycleState: 'active', deletedAt: null }
      }
      await withMutatedMethod(
        TenantRepository.prototype,
        'findByIdIncludingDeleted',
        staleFirstRead,
        () =>
          expect(
            reissueOwnerInvitation({ userId: admin.id }, tenantId, 'z@example.test', 'Resend')
          ).rejects.toMatchObject({
            statusCode: 409,
            message: 'Cannot invite an owner to an archived tenant.',
          })
      )
      expect(calls).toBe(2)
    })

    it('answers 409 when the address already belongs to a member', async () => {
      const { token } = await staff('admin')
      const created = await create(token, {
        name: 'Has Admin',
        slug: newSlug(),
        ownerEmail: `f-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id
      const { user: member } = await createUser(true)
      await userMembershipRepository.create({ userId: member.id, tenantId, role: 'admin' })

      const response = await reissue(token, tenantId, member.email)

      expect(response.status).toBe(409)
      expect((response.body as { code?: string }).code).toBe('already_member')
    })

    it('answers 409 invitee_deactivated for a deactivated account, keeping the pending invitation', async () => {
      const { token } = await staff('admin')
      const first = `k-${randomUUID()}@example.test`
      const created = await create(token, { name: 'Keep', slug: newSlug(), ownerEmail: first })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id
      const { user: inactive } = await createUser(true)
      await sql`update users set active = false where id = ${inactive.id}`

      const response = await reissue(token, tenantId, inactive.email)

      expect(response.status).toBe(409)
      expect(response.body as { message: string; code?: string }).toMatchObject({
        message: 'That account is deactivated',
        code: INVITEE_DEACTIVATED_CODE,
      })
      const pending = await sql<{ email: string }[]>`select email from tenant_invitations
        where tenant_id = ${tenantId} and accepted_at is null and revoked_at is null`
      expect(pending.map((row) => row.email)).toEqual([first])
    })

    it('answers emailSent: false when the mail cannot be queued, keeping the new invitation', async () => {
      const { token } = await staff('admin')
      const created = await create(token, {
        name: 'No Mail',
        slug: newSlug(),
        ownerEmail: `m-${randomUUID()}@example.test`,
      })
      const tenantId = (created.body as { data: CreatedBody }).data.tenant.id
      const second = `m2-${randomUUID()}@example.test`

      let response: Response | undefined
      await withMutatedMethod(
        getEmailQueue(),
        'add',
        (): Promise<never> => Promise.reject(new Error('queue unavailable')),
        async () => {
          response = await reissue(token, tenantId, second)
        }
      )

      expect(response?.status).toBe(200)
      expect((response?.body as { data: { emailSent: boolean } }).data.emailSent).toBe(false)
      const pending = await sql<{ email: string }[]>`select email from tenant_invitations
        where tenant_id = ${tenantId} and accepted_at is null and revoked_at is null`
      expect(pending.map((row) => row.email)).toEqual([second])
    })

    it('answers 404 for an unknown or malformed id', async () => {
      const { token } = await staff('admin')

      const response = await reissue(token, randomUUID(), 'z@example.test')
      expect(response.status).toBe(404)
      const response2 = await reissue(token, 'nope', 'z@example.test')
      expect(response2.status).toBe(404)
    })
  })
})
