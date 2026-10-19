/**
 * @file `POST /api/v1/invitations/verify`: one click on an invitation link
 * signs the invitee in and joins them, creating a verified account when the
 * address has none. The link is single-use: a second presentation, by
 * anyone, answers the generic `invitation_invalid` with no session, and so
 * does every dead link, before any account is created. No Worker runs; the
 * file reads rows straight from the database.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { REAUTH_REQUIRED_CODE } from '@/constants/auth.constants'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken, issueRefreshToken } from '@/services/session.service'
import type { DomainEvent } from '@/types/domain-event'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { platformTenant } from '../../helpers/platform-staff'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'
import { signInByLink } from '../../helpers/sign-in'

const app = createApp()
const authProviderRepository = new AuthProviderRepository()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()
const { name: REFRESH_COOKIE_NAME } = testRefreshCookie()

const HOUR_MS = 60 * 60 * 1000

/**
 * The generic dead-link answer, without its per-request id.
 */
const INVALID = {
  success: false,
  statusCode: 404,
  code: 'invitation_invalid',
  message:
    'This invitation link has expired or was already used. Ask the person who invited you for a new one.',
}

/**
 * Every address this file used, lowercased, for `afterEach` to delete the
 * accounts a click created.
 */
const usedEmails: string[] = []

/**
 * Every tenant this file created, for `afterEach` to delete.
 */
const createdTenantIds: string[] = []

/**
 * Every domain event emitted while this file runs, in order.
 */
const emitted: DomainEvent[] = []
for (const type of [
  'user_signed_up',
  'user_signed_in',
  'email_verified',
  'invitation_accepted',
] as const) {
  subscribeDomainEvent(type, (event) => {
    emitted.push(event)
  })
}

/**
 * A fresh address for one test, recorded for cleanup.
 * @param label - A tag naming the test, for reading rows while debugging.
 * @returns The address, lowercase.
 */
function uniqueEmail(label: string): string {
  const email = `invite-verify-${label}-${randomUUID()}@example.test`
  usedEmails.push(email)
  return email
}

/**
 * A customer tenant named Acme Inc owned by a fresh user, tracked for cleanup.
 * @returns The tenant and its owner.
 */
async function createTenant(): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser({ firstName: 'Ada', lastName: 'Lovelace' })
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `invite-verify-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * Write a pending invitation with a known raw token, bypassing the API.
 * @param tenant - The tenant it invites to.
 * @param inviter - Who sent it.
 * @param email - The invited address.
 * @param role - The offered role; editor by default.
 * @returns The raw token and the invitation's id.
 */
async function seedInvitation(
  tenant: Tenant,
  inviter: User,
  email: string,
  role: MembershipRole = 'editor'
): Promise<{ rawToken: string; invitationId: string }> {
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role,
        tokenHash: hashToken(rawToken),
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return { rawToken, invitationId: invitation.id }
}

/**
 * Post an invitation verify.
 * @param token - The raw token.
 * @param cookie - A `Cookie` header to present, if any.
 * @returns The response.
 */
function postVerify(token: string, cookie?: string): Promise<Response> {
  const pending = request(app).post('/api/v1/invitations/verify')
  if (cookie !== undefined) pending.set('Cookie', cookie)
  return pending.send({ token })
}

/**
 * The `data` of a verify that answered 200.
 */
interface VerifyData {
  user: { id: string; email: string; platformRole: string | null }
  accessToken: string
  isNewUser: boolean
  tenant: { name: string; slug: string }
  role: MembershipRole
}

/**
 * Read a 200 verify's data.
 * @param response - The response.
 * @returns Its `data`.
 */
function verifyData(response: Response): VerifyData {
  return (response.body as { data: VerifyData }).data
}

/**
 * Whether the response set the refresh cookie.
 * @param response - The response.
 * @returns True when a `Set-Cookie` line names the refresh cookie.
 */
function hasRefreshCookie(response: Response): boolean {
  const lines = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  return lines.some((line) => line.startsWith(`${REFRESH_COOKIE_NAME}=`))
}

/**
 * A user's refresh rows: whether each is revoked.
 * @param userId - The user.
 * @returns One flag per row, oldest first.
 */
async function refreshRows(userId: string): Promise<{ revoked: boolean }[]> {
  return sql<{ revoked: boolean }[]>`
    select revoked_at is not null as revoked from user_tokens
    where user_id = ${userId} and purpose = 'refresh'
    order by created_at, id
  `
}

/**
 * How many accounts, live or soft-deleted, hold an address.
 * @param email - The address.
 * @returns The count of user rows.
 */
async function userCount(email: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from users where lower(email) = ${email.toLowerCase()}
  `
  return row?.count ?? 0
}

/**
 * Whether an invitation is still pending: not accepted and not revoked.
 * @param invitationId - The invitation.
 * @returns True while it is pending.
 */
async function isPending(invitationId: string): Promise<boolean> {
  const [row] = await sql<{ pending: boolean }[]>`
    select accepted_at is null and revoked_at is null as pending
    from tenant_invitations where id = ${invitationId}
  `
  return row?.pending === true
}

/**
 * The events emitted for one user, by type.
 * @param userId - The user.
 * @returns The events, in emit order.
 */
function eventsFor(userId: string): DomainEvent[] {
  return emitted.filter((event) => 'userId' in event && event.userId === userId)
}

/**
 * Delete every key of the verify limiter, so the IP-keyed budget this file
 * spends does not carry from one test to the next.
 */
async function clearVerifyLimiter(): Promise<void> {
  const client = await getRedis()
  const keys: string[] = []
  const batches = client.scanIterator({ MATCH: `${redisKey('rl', 'invitation-verify')}:*` })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await client.del(keys)
}

beforeEach(async () => {
  await clearVerifyLimiter()
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (usedEmails.length > 0) {
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

describe('POST /api/v1/invitations/verify', () => {
  it('creates a verified account, joins with the invited role and signs in', async () => {
    const { tenant, owner } = await createTenant()
    const email = uniqueEmail('new')
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, email, 'manager')

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect((response.body as { message: string }).message).toBe('Invitation accepted.')
    const data = verifyData(response)
    expect(data.isNewUser).toBe(true)
    expect(data.tenant).toStrictEqual({ name: 'Acme Inc', slug: tenant.slug })
    expect(data.role).toBe('manager')
    expect(data.user.email).toBe(email)
    expect(data.user.platformRole).toBeNull()
    expect(data.accessToken).toEqual(expect.any(String))
    expect(hasRefreshCookie(response)).toBe(true)

    const created = await userRepository.findByEmail(email)
    expect(created?.id).toBe(data.user.id)
    expect(created?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(created?.lastLoggedInAt).toBeInstanceOf(Date)
    const membership = await userMembershipRepository.findByUserAndTenant(data.user.id, tenant.id)
    expect(membership?.role).toBe('manager')
    expect(await refreshRows(data.user.id)).toEqual([{ revoked: false }])
    const [invitation] = await sql<{ acceptedBy: string | null }[]>`
      select accepted_by as "acceptedBy" from tenant_invitations where id = ${invitationId}
    `
    expect(invitation?.acceptedBy).toBe(data.user.id)
    const audits = await sql<{ actorId: string; targetId: string; metadata: unknown }[]>`
      select actor_user_id as "actorId", target_id as "targetId", metadata from audit_logs
      where action = 'invitation.accepted' and tenant_id = ${tenant.id}
    `
    expect(audits).toEqual([
      {
        actorId: data.user.id,
        targetId: membership?.id,
        metadata: { role: 'manager', invitationId },
      },
    ])
    const types = eventsFor(data.user.id).map((event) => event.type)
    expect(types).toEqual(
      expect.arrayContaining([
        'email_verified',
        'invitation_accepted',
        'user_signed_up',
        'user_signed_in',
      ])
    )
    expect(eventsFor(data.user.id)).toContainEqual(
      expect.objectContaining({ type: 'user_signed_up', method: 'link' })
    )
    expect(eventsFor(data.user.id)).toContainEqual(
      expect.objectContaining({ type: 'user_signed_in', method: 'link' })
    )
    expect(eventsFor(data.user.id)).toContainEqual(
      expect.objectContaining({
        type: 'invitation_accepted',
        tenantId: tenant.id,
        role: 'manager',
        wasFirstMember: false,
      })
    )
  })

  it('signs an existing account in and joins it', async () => {
    const { tenant, owner } = await createTenant()
    const invitee = await createTrackedUser({ email: uniqueEmail('existing') })
    const { rawToken } = await seedInvitation(tenant, owner, invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.isNewUser).toBe(false)
    expect(data.user.id).toBe(invitee.id)
    expect(data.role).toBe('editor')
    expect(hasRefreshCookie(response)).toBe(true)
    const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    expect(membership?.role).toBe('editor')
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false }])
    const types = eventsFor(invitee.id).map((event) => event.type)
    expect(types).toEqual(['invitation_accepted', 'user_signed_in'])
  })

  it('verifies a never-verified invitee and revokes their earlier sessions', async () => {
    const { tenant, owner } = await createTenant()
    const invitee = await createTrackedUser({
      email: uniqueEmail('never-verified'),
      verified: false,
    })
    await issueRefreshToken(invitee.id, randomUUID())
    await authProviderRepository.create({
      userId: invitee.id,
      provider: 'email',
      providerId: invitee.email,
    })
    // A squatter's own Google link on the never-verified account.
    await authProviderRepository.create({
      userId: invitee.id,
      provider: 'google',
      providerId: randomUUID(),
    })
    const { rawToken } = await seedInvitation(tenant, owner, invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    expect(verifyData(response).isNewUser).toBe(false)
    expect(verifyData(response).user.id).toBe(invitee.id)
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: true }, { revoked: false }])
    const claimed = await userRepository.findById(invitee.id)
    expect(claimed?.emailVerifiedAt).toBeInstanceOf(Date)
    // The click proves the mailbox, so a squatter's federated links go.
    const providers = await authProviderRepository.findByUser(invitee.id)
    expect(providers.map((provider) => provider.provider)).toEqual(['email'])
    expect(eventsFor(invitee.id).filter((event) => event.type === 'email_verified')).toHaveLength(1)
    const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    expect(membership?.role).toBe('editor')
  })

  it('answers invitation_invalid for a used link, even for the invitee, and issues no session', async () => {
    const { tenant, owner } = await createTenant()
    const email = uniqueEmail('used')
    const { rawToken } = await seedInvitation(tenant, owner, email)
    const first = await postVerify(rawToken)
    expect(first.status).toBe(200)
    const inviteeId = verifyData(first).user.id
    const firstCookie = ((first.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((line) => line.split(';', 1)[0] ?? '')
      .find((pair) => pair.startsWith(`${REFRESH_COOKIE_NAME}=`))

    const second = await postVerify(rawToken, firstCookie)

    expect(second.status).toBe(404)
    expect(second.body).toMatchObject(INVALID)
    expect(second.headers['set-cookie']).toBeUndefined()
    // The invitee's own session survives a refused second click.
    expect(await refreshRows(inviteeId)).toEqual([{ revoked: false }])
  })

  it('answers invitation_invalid for expired, revoked, suspended-tenant and archived-tenant links and creates no account', async () => {
    const expired = await createTenant()
    const expiredEmail = uniqueEmail('expired')
    const expiredLink = await seedInvitation(expired.tenant, expired.owner, expiredEmail)
    await sql`
      update tenant_invitations set expires_at = now() - interval '1 minute'
      where id = ${expiredLink.invitationId}
    `
    const revoked = await createTenant()
    const revokedEmail = uniqueEmail('revoked')
    const revokedLink = await seedInvitation(revoked.tenant, revoked.owner, revokedEmail)
    await invitationRepository.revoke(revoked.tenant.id, revokedLink.invitationId)
    const suspended = await createTenant()
    const suspendedEmail = uniqueEmail('suspended')
    const suspendedLink = await seedInvitation(suspended.tenant, suspended.owner, suspendedEmail)
    await sql`update tenants set lifecycle_state = 'suspended' where id = ${suspended.tenant.id}`
    const archived = await createTenant()
    const archivedEmail = uniqueEmail('archived')
    const archivedLink = await seedInvitation(archived.tenant, archived.owner, archivedEmail)
    await sql`
      update tenants set lifecycle_state = 'archived', deleted_at = now()
      where id = ${archived.tenant.id}
    `
    const cases = [
      { email: expiredEmail, token: expiredLink.rawToken },
      { email: revokedEmail, token: revokedLink.rawToken },
      { email: suspendedEmail, token: suspendedLink.rawToken },
      { email: archivedEmail, token: archivedLink.rawToken },
      { email: uniqueEmail('unknown'), token: randomBytes(32).toString('base64url') },
      { email: uniqueEmail('malformed'), token: 'not a token at all' },
    ]

    for (const { email, token } of cases) {
      const before = await userCount(email)
      const response = await postVerify(token)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(await userCount(email)).toBe(before)
    }
  })

  it('answers invitation_invalid for a deactivated invitee', async () => {
    const { tenant, owner } = await createTenant()
    const invitee = await createTrackedUser({ email: uniqueEmail('deactivated'), active: false })
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject(INVALID)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(await refreshRows(invitee.id)).toEqual([])
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    // Refused before the claim: the link is not spent.
    expect(await isPending(invitationId)).toBe(true)
  })

  it('answers invitation_invalid for a deactivated, never-verified invitee without claiming the account', async () => {
    const { tenant, owner } = await createTenant()
    const invitee = await createTrackedUser({
      email: uniqueEmail('deactivated-unverified'),
      active: false,
      verified: false,
    })
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject(INVALID)
    expect(response.headers['set-cookie']).toBeUndefined()
    const untouched = await userRepository.findById(invitee.id)
    expect(untouched?.emailVerifiedAt).toBeNull()
    expect(await isPending(invitationId)).toBe(true)
  })

  it('lands a platform invitee as staff', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const email = uniqueEmail('staff')
    const { rawToken } = await seedInvitation(platform, inviter, email, 'viewer')

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.isNewUser).toBe(true)
    expect(data.role).toBe('viewer')
    expect(data.tenant.slug).toBe(platform.slug)
    expect(data.user.platformRole).toBe('viewer')
  })

  it('issues a session that does not count as a recent sign-in, so a step-up route answers REAUTH_REQUIRED', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const email = uniqueEmail('staff-stale')
    const { rawToken } = await seedInvitation(platform, inviter, email, 'admin')

    const response = await postVerify(rawToken)
    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.user.platformRole).toBe('admin')

    const [row] = await sql<{ authenticated: boolean }[]>`
      select authenticated_at is not null as authenticated from user_tokens
      where user_id = ${data.user.id} and purpose = 'refresh'
    `
    expect(row?.authenticated).toBe(false)

    const refused = await request(app)
      .post(`/api/v1/platform/users/${randomUUID()}/deactivate`)
      .set('Authorization', `Bearer ${data.accessToken}`)
      .send({})
    expect(refused.status).toBe(401)
    expect(refused.body).toMatchObject({ code: REAUTH_REQUIRED_CODE })
  })

  it('keeps an existing membership’s role and still signs in', async () => {
    const { tenant, owner } = await createTenant()
    const invitee = await createTrackedUser({ email: uniqueEmail('member') })
    const { rawToken } = await seedInvitation(tenant, owner, invitee.email, 'viewer')
    await userMembershipRepository.create({
      userId: invitee.id,
      tenantId: tenant.id,
      role: 'admin',
    })

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    expect(verifyData(response).role).toBe('admin')
    expect(eventsFor(invitee.id).map((event) => event.type)).toEqual(['user_signed_in'])
  })

  it('revokes the session the browser presented', async () => {
    const { tenant, owner } = await createTenant()
    const email = uniqueEmail('presented')
    const earlier = await signInByLink(email)
    const { rawToken } = await seedInvitation(tenant, owner, email)

    const response = await postVerify(rawToken, earlier.refreshCookie)

    expect(response.status).toBe(200)
    expect(await refreshRows(earlier.userId)).toEqual([{ revoked: true }, { revoked: false }])
  })

  it('signs in the invitee, not the signed-in user, and revokes the session they presented', async () => {
    const { tenant, owner } = await createTenant()
    const signedIn = await signInByLink(uniqueEmail('someone-else'))
    const invitee = await createTrackedUser({ email: uniqueEmail('invitee-b') })
    const { rawToken } = await seedInvitation(tenant, owner, invitee.email)

    const response = await request(app)
      .post('/api/v1/invitations/verify')
      .set('Cookie', signedIn.refreshCookie)
      .set('Authorization', `Bearer ${signedIn.accessToken}`)
      .send({ token: rawToken })

    expect(response.status).toBe(200)
    expect(verifyData(response).user.id).toBe(invitee.id)
    expect(await refreshRows(signedIn.userId)).toEqual([{ revoked: true }])
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false }])
    expect(
      await userMembershipRepository.findByUserAndTenant(signedIn.userId, tenant.id)
    ).toBeUndefined()
  })

  it('refuses a disallowed Origin', async () => {
    const { tenant, owner } = await createTenant()
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, uniqueEmail('origin'))

    const response = await request(app)
      .post('/api/v1/invitations/verify')
      .set('Origin', 'https://evil.test')
      .send({ token: rawToken })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    expect(await isPending(invitationId)).toBe(true)
  })

  it('answers 415 for a form body', async () => {
    const { tenant, owner } = await createTenant()
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, uniqueEmail('form'))

    const response = await request(app)
      .post('/api/v1/invitations/verify')
      .type('form')
      .send(`token=${rawToken}`)

    expect(response.status).toBe(415)
    expect(await isPending(invitationId)).toBe(true)
  })

  it('answers 429 past the IP budget', async () => {
    for (let index = 0; index < 20; index += 1) {
      const junk = await postVerify(randomBytes(32).toString('base64url'))
      expect(junk.status).toBe(404)
    }

    const limited = await postVerify(randomBytes(32).toString('base64url'))

    expect(limited.status).toBe(429)
  })

  it('is refused in read_only and full with the maintenance codes', async () => {
    const { tenant, owner } = await createTenant()
    const email = uniqueEmail('maintenance')
    const { rawToken, invitationId } = await seedInvitation(tenant, owner, email)

    await storeMaintenanceMode('read_only')
    await reloadMaintenanceMode()
    const readOnly = await postVerify(rawToken)
    await storeMaintenanceMode('full')
    await reloadMaintenanceMode()
    const full = await postVerify(rawToken)

    expect(readOnly.status).toBe(503)
    expect(readOnly.body).toMatchObject({ code: READ_ONLY_MODE_CODE })
    expect(full.status).toBe(503)
    expect(full.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
    expect(await userCount(email)).toBe(0)
    expect(await isPending(invitationId)).toBe(true)
  })
})
