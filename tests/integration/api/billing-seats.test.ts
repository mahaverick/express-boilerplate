/**
 * @file The members limit over HTTP: an invite, a resend and every join path
 * against a Free workspace's three seats, the staff owner invitation that
 * never needs one, and the trial a staff-made workspace starts when its first
 * owner joins by verify or confirm.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { initialBillingFor } from '@/services/billing/trial.service'
import { db, sql, withTransaction } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { backdateInvitationSend } from '../../helpers/backdate'
import { putTenantOnPaid } from '../../helpers/billing'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
  tokenFor,
} from '../../helpers/platform-users'
import { request } from '../../helpers/request'

const app = createApp()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const invitationRepository = new TenantInvitationRepository()

const DAY_MS = 24 * 60 * 60 * 1000
const FULL = {
  success: false,
  statusCode: 402,
  code: 'PLAN_LIMIT_REACHED',
  message: 'This workspace is full on its current plan. Ask an owner to upgrade.',
}
const tenantIds: string[] = []
const usedEmails: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  if (usedEmails.length > 0) await sql`delete from users where email = any(${usedEmails})`
  usedEmails.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * An address no row holds yet, removed with any account made for it.
 * @returns The address.
 */
function freshEmail(): string {
  const email = `seats-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * Add `count` viewers to a workspace.
 * @param tenant - The workspace.
 * @param count - How many.
 * @returns The new members.
 */
async function addViewers(tenant: Tenant, count: number): Promise<User[]> {
  const added: User[] = []
  for (let index = 0; index < count; index += 1) {
    const member = await createTrackedUser()
    await membershipRepository.create({ userId: member.id, tenantId: tenant.id, role: 'viewer' })
    added.push(member)
  }
  return added
}

/**
 * A Free workspace with its owner and `viewers` more members.
 * @param viewers - Members beyond the owner.
 * @returns The workspace and its owner.
 */
async function workspace(viewers = 0): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Seats Co',
    slug: `seats-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  await addViewers(tenant, viewers)
  return { tenant, owner }
}

/**
 * A staff-made workspace with no owner, waiting for its first owner's trial.
 * @param viewers - Members it holds.
 * @returns The workspace.
 */
async function ownerlessWorkspace(viewers = 0): Promise<Tenant> {
  const tenant = await withTransaction(async (tx) =>
    tenantRepository.createWithoutOwner(
      { name: 'Staff Made', slug: `seats-staff-${randomUUID()}` },
      tx,
      await initialBillingFor(null, tx)
    )
  )
  tenantIds.push(tenant.id)
  await addViewers(tenant, viewers)
  return tenant
}

/**
 * Write a pending invitation with a known raw token.
 * @param tenant - The workspace.
 * @param options - The address, role, inviter and expiry.
 * @returns The raw token and the invitation id.
 */
async function seedInvitation(
  tenant: Tenant,
  options: { email: string; role?: MembershipRole; invitedBy: string; expiresAt?: Date }
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email: options.email,
        role: options.role ?? 'viewer',
        tokenHash: hashToken(rawToken),
        invitedBy: options.invitedBy,
        expiresAt: options.expiresAt ?? new Date(Date.now() + DAY_MS),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * POST an invitation as `inviter`.
 */
function inviteAs(inviter: User, tenant: Tenant, email: string): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${tenant.slug}/invitations`)
    .set('Authorization', `Bearer ${tokenFor(inviter)}`)
    .send({ email, role: 'viewer' })
}

/**
 * Resend an invitation as `inviter`.
 */
function resendAs(inviter: User, tenant: Tenant, invitationId: string): Promise<Response> {
  return request(app)
    .post(`/api/v1/tenants/${tenant.slug}/invitations/${invitationId}/resend`)
    .set('Authorization', `Bearer ${tokenFor(inviter)}`)
}

/**
 * Accept an invitation signed in as `user`.
 */
function acceptAs(user: User, rawToken: string): Promise<Response> {
  return request(app)
    .post('/api/v1/invitations/accept')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ token: rawToken })
}

/**
 * Issue an invitation confirm link for `email`, as the verify's follow-up would.
 */
async function confirmLinkFor(email: string, invitationId: string): Promise<string> {
  const { raw } = await issueLinkToken(
    { intent: 'invitation', email, app: 'web', invitationId },
    requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  )
  return raw
}

/**
 * Move a workspace from Paid back to Free, as a lapse would.
 */
async function downgrade(tenantId: string): Promise<void> {
  await sql`update tenant_billing set state = 'free', plan_id = (select id from plans where key = 'free'), version = version + 1 where tenant_id = ${tenantId}`
}

/**
 * The billing state stored for a workspace.
 */
async function storedState(tenantId: string): Promise<string | undefined> {
  const [row] = await sql<
    { state: string }[]
  >`select state from tenant_billing where tenant_id = ${tenantId}`
  return row?.state
}

describe('the members limit on invitations', () => {
  it('refuses an invite at 3 of 3 with 402 and the usage, and writes nothing', async () => {
    const { tenant, owner } = await workspace(2)
    const email = freshEmail()

    const response = await inviteAs(owner, tenant, email)

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject({
      success: false,
      statusCode: 402,
      code: 'PLAN_LIMIT_REACHED',
      message: "You've used 3 of 3 members on Free. Upgrade to add more.",
      details: { key: 'members', used: 3, limit: 3 },
    })
    const rows = await sql`select 1 from tenant_invitations where email = ${email}`
    expect(rows).toHaveLength(0)
  })

  it('lets an owner re-invite a pending address at 3 of 3', async () => {
    const { tenant, owner } = await workspace(1)
    const email = freshEmail()
    await seedInvitation(tenant, { email, invitedBy: owner.id })

    const response = await inviteAs(owner, tenant, email)

    expect(response.status).toBe(202)
  })

  it('does not count an expired invitation', async () => {
    const { tenant, owner } = await workspace(1)
    await seedInvitation(tenant, {
      email: freshEmail(),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() - DAY_MS),
    })

    const response = await inviteAs(owner, tenant, freshEmail())

    expect(response.status).toBe(202)
  })

  it('refuses a resend of an expired invitation at 3 of 3', async () => {
    const { tenant, owner } = await workspace(2)
    const { invitationId } = await seedInvitation(tenant, {
      email: freshEmail(),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() - DAY_MS),
    })
    await backdateInvitationSend(invitationId)

    const response = await resendAs(owner, tenant, invitationId)

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { key: 'members', used: 3, limit: 3 },
    })
  })

  it('lets a pending invitation be resent at 3 of 3, since it holds its seat', async () => {
    const { tenant, owner } = await workspace(1)
    const { invitationId } = await seedInvitation(tenant, {
      email: freshEmail(),
      invitedBy: owner.id,
    })
    await backdateInvitationSend(invitationId)

    const response = await resendAs(owner, tenant, invitationId)

    expect(response.status).toBe(202)
  })

  it('does not count a soft-deleted member', async () => {
    const { tenant, owner } = await workspace()
    const [gone] = await addViewers(tenant, 2)
    await sql`update users set deleted_at = now() where id = ${gone?.id ?? ''}`

    const response = await inviteAs(owner, tenant, freshEmail())

    expect(response.status).toBe(202)
  })

  it('lets staff invite an owner to an ownerless workspace at 3 of 3', async () => {
    const tenant = await ownerlessWorkspace(3)
    const { token } = await createTrackedStaff('admin')
    const email = freshEmail()

    const response = await request(app)
      .post(`/api/v1/platform/tenants/${tenant.id}/owner-invitation`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email, reason: 'The owner left the workspace.' })

    expect(response.status).toBe(200)
    const rows = await sql`select role from tenant_invitations where email = ${email}`
    expect(rows).toEqual([{ role: 'owner' }])
  })
})

describe('the members limit on joins', () => {
  it('accepts a staff owner invitation at 3 of 3: a workspace can always get an owner', async () => {
    const tenant = await ownerlessWorkspace(3)
    const { user: staff } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenant, {
      email: invitee.email,
      role: 'owner',
      invitedBy: staff.id,
    })

    const response = await acceptAs(invitee, rawToken)

    expect(response.status).toBe(200)
    const membership = await membershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    expect(membership?.role).toBe('owner')
  })

  it('refuses an accept after a downgrade with the full message and no usage', async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    await addViewers(tenant, 3)
    const invitee = await createTrackedUser()
    const { rawToken, invitationId } = await seedInvitation(tenant, {
      email: invitee.email,
      invitedBy: owner.id,
    })
    await downgrade(tenant.id)

    const response = await acceptAs(invitee, rawToken)

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
    expect(await membershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeUndefined()
    const [row] = await sql<{ accepted_at: Date | null }[]>`
      select accepted_at from tenant_invitations where id = ${invitationId}`
    expect(row?.accepted_at).toBeNull()
  })

  it('refuses a one-click verify after a downgrade and creates no account', async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    await addViewers(tenant, 3)
    const email = freshEmail()
    const { rawToken } = await seedInvitation(tenant, { email, invitedBy: owner.id })
    await downgrade(tenant.id)

    const response = await request(app).post('/api/v1/invitations/verify').send({ token: rawToken })

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0)
  })

  it('refuses a confirm after a downgrade and leaves the link unspent', async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    await addViewers(tenant, 3)
    const invitee = await createTrackedUser()
    const { invitationId } = await seedInvitation(tenant, {
      email: invitee.email,
      invitedBy: owner.id,
    })
    const link = await confirmLinkFor(invitee.email, invitationId)
    await downgrade(tenant.id)

    const response = await request(app).post('/api/v1/invitations/confirm').send({ token: link })

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
    const [token] = await sql<{ consumed_at: Date | null }[]>`
      select consumed_at from user_tokens where token_hash = ${hashToken(link)}`
    expect(token).toBeDefined()
    expect(token?.consumed_at).toBeNull()
  })
})

/**
 * A workspace that took 5 people on Paid and fell back to Free, plus a
 * pending invitation of `role` from its owner to a person with an account.
 * @returns The workspace, the invitee and the invitation's raw token and id.
 */
async function overLimitWithInvitation(role: MembershipRole) {
  const { tenant, owner } = await workspace()
  await putTenantOnPaid(tenant.id)
  await addViewers(tenant, 4)
  const invitee = await createTrackedUser()
  const seeded = await seedInvitation(tenant, { email: invitee.email, role, invitedBy: owner.id })
  await downgrade(tenant.id)
  return { tenant, invitee, ...seeded }
}

describe('who a full workspace still lets join', () => {
  it('lets a non-owner join at exactly the limit', async () => {
    const { tenant, owner } = await workspace(1)
    const invitee = await createTrackedUser()
    const { rawToken } = await seedInvitation(tenant, {
      email: invitee.email,
      invitedBy: owner.id,
    })

    const response = await acceptAs(invitee, rawToken)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { alreadyMember: false } })
  })

  it('answers a member who accepts again alreadyMember, over the limit, and claims the invitation', async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    const [member] = await addViewers(tenant, 4)
    const { rawToken, invitationId } = await seedInvitation(tenant, {
      email: member?.email ?? '',
      invitedBy: owner.id,
    })
    await downgrade(tenant.id)

    const response = await acceptAs(member as User, rawToken)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ data: { alreadyMember: true } })
    const [row] = await sql<{ accepted_at: Date | null }[]>`
      select accepted_at from tenant_invitations where id = ${invitationId}`
    expect(row?.accepted_at).not.toBeNull()
  })

  it("refuses an owner's owner invitation at accept when the workspace is full", async () => {
    const { tenant, invitee, rawToken } = await overLimitWithInvitation('owner')

    const response = await acceptAs(invitee, rawToken)

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
    expect(await membershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeUndefined()
  })

  it("refuses an owner's owner invitation at confirm when the workspace is full", async () => {
    const { invitee, invitationId } = await overLimitWithInvitation('owner')
    const link = await confirmLinkFor(invitee.email, invitationId)

    const response = await request(app).post('/api/v1/invitations/confirm').send({ token: link })

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
  })

  it("refuses an owner's owner invitation to a new address at one-click verify when full", async () => {
    const { tenant, owner } = await workspace()
    await putTenantOnPaid(tenant.id)
    await addViewers(tenant, 4)
    const email = freshEmail()
    const { rawToken } = await seedInvitation(tenant, { email, role: 'owner', invitedBy: owner.id })
    await downgrade(tenant.id)

    const response = await request(app).post('/api/v1/invitations/verify').send({ token: rawToken })

    expect(response.status).toBe(402)
    expect(response.body).toMatchObject(FULL)
    expect(response.body).not.toHaveProperty('details')
  })

  it('lets a new address join an ownerless workspace at 3 of 3 as owner by one click', async () => {
    const tenant = await ownerlessWorkspace(3)
    const { user: staff } = await createTrackedStaff('admin')
    const email = freshEmail()
    const { rawToken } = await seedInvitation(tenant, { email, role: 'owner', invitedBy: staff.id })

    const response = await request(app).post('/api/v1/invitations/verify').send({ token: rawToken })

    expect(response.status).toBe(200)
  })

  it('lets an address with an account confirm into an ownerless workspace at 3 of 3 as owner', async () => {
    const tenant = await ownerlessWorkspace(3)
    const { user: staff } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const { invitationId } = await seedInvitation(tenant, {
      email: invitee.email,
      role: 'owner',
      invitedBy: staff.id,
    })
    const link = await confirmLinkFor(invitee.email, invitationId)

    const response = await request(app).post('/api/v1/invitations/confirm').send({ token: link })

    expect(response.status).toBe(200)
    const membership = await membershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    expect(membership?.role).toBe('owner')
  })
})

describe("a staff-made workspace's trial on its first owner's join", () => {
  it('starts when a new address joins as owner by one click', async () => {
    const tenant = await ownerlessWorkspace()
    const { user: staff } = await createTrackedStaff('admin')
    const email = freshEmail()
    const { rawToken } = await seedInvitation(tenant, { email, role: 'owner', invitedBy: staff.id })

    const response = await request(app).post('/api/v1/invitations/verify').send({ token: rawToken })

    expect(response.status).toBe(200)
    expect(await storedState(tenant.id)).toBe('trialing')
  })

  it('starts when an address with an account confirms as owner', async () => {
    const tenant = await ownerlessWorkspace()
    const { user: staff } = await createTrackedStaff('admin')
    const invitee = await createTrackedUser()
    const { invitationId } = await seedInvitation(tenant, {
      email: invitee.email,
      role: 'owner',
      invitedBy: staff.id,
    })
    const link = await confirmLinkFor(invitee.email, invitationId)

    const response = await request(app).post('/api/v1/invitations/confirm').send({ token: link })

    expect(response.status).toBe(200)
    expect(await storedState(tenant.id)).toBe('trialing')
  })
})
