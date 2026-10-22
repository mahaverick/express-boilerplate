/**
 * @file `POST /api/v1/invitations/confirm`: the emailed link an existing
 * account or a staff invitee gets instead of the one-click join. Its click
 * signs the invitee in, counted as a recent sign-in, and joins them. Every
 * refusal (a dead or mismatched link, a dead invitation, a deactivated
 * account) answers one `404 invitation_invalid` and spends nothing. The
 * links are minted straight through `issueLinkToken`, as the verify's
 * follow-up does; no Worker runs.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import type { FrontendApp } from '@/constants/frontend.constants'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { db, sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { issueLinkToken } from '@/services/link-token.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { deactivateUser, signOutUser } from '@/services/platform-user.service'
import { hashToken, issueRefreshToken, revokeOtherSessions } from '@/services/session.service'
import type { DomainEvent } from '@/types/domain-event'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { passkeyCount, seedPasskey } from '../../helpers/passkey-rows'
import { platformTenant } from '../../helpers/platform-staff'
import {
  createTrackedStaff,
  createTrackedUser,
  deleteTrackedUsers,
} from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'

const app = createApp()
const authProviderRepository = new AuthProviderRepository()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userTokenRepository = new UserTokenRepository()
const { name: REFRESH_COOKIE_NAME } = testRefreshCookie()

const HOUR_MS = 60 * 60 * 1000

/**
 * The generic refusal, without its per-request id.
 */
const INVALID = {
  success: false,
  statusCode: 404,
  code: 'invitation_invalid',
  message:
    "We couldn't use this link. Open your invitation email and select Join again, or ask the person who invited you for a new invite.",
}

/**
 * Every address this file used, lowercased, for `afterEach` to delete the
 * accounts a click created and the links minted for it.
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
  const email = `invite-confirm-${label}-${randomUUID()}@example.test`
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
    slug: `invite-confirm-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  return { tenant, owner }
}

/**
 * Write a pending invitation, bypassing the API.
 * @param tenant - The tenant it invites to.
 * @param inviter - Who sent it.
 * @param email - The invited address.
 * @param role - The offered role; editor by default.
 * @returns The invitation's id.
 */
async function seedInvitation(
  tenant: Tenant,
  inviter: User,
  email: string,
  role: MembershipRole = 'editor'
): Promise<string> {
  const invitation = await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role,
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return invitation.id
}

/**
 * Mint the confirm link the verify's follow-up mails, valid for `SIGN_IN_LINK_TTL`.
 * @param email - The invited address.
 * @param invitationId - The invitation it joins.
 * @param linkApp - The frontend it opens; `web` by default.
 * @returns The raw token.
 */
async function issueConfirmLink(
  email: string,
  invitationId: string,
  linkApp: FrontendApp = 'web'
): Promise<string> {
  const { raw } = await issueLinkToken(
    { intent: 'invitation', email, app: linkApp, invitationId },
    requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
  )
  return raw
}

/**
 * A customer invitation for `email` with a live confirm link.
 * @param email - The invited address.
 * @param role - The offered role.
 * @returns The tenant, the invitation's id and the link's raw token.
 */
async function invitedWithLink(
  email: string,
  role: MembershipRole = 'editor'
): Promise<{ tenant: Tenant; invitationId: string; raw: string }> {
  const { tenant, owner } = await createTenant()
  const invitationId = await seedInvitation(tenant, owner, email, role)
  const raw = await issueConfirmLink(email, invitationId)
  return { tenant, invitationId, raw }
}

/**
 * Post a confirm.
 * @param body - The JSON body.
 * @param cookie - A `Cookie` header to present, if any.
 * @returns The response.
 */
function postConfirm(body: Record<string, unknown>, cookie?: string): Promise<Response> {
  const pending = request(app).post('/api/v1/invitations/confirm')
  if (cookie !== undefined) pending.set('Cookie', cookie)
  return pending.send(body)
}

/**
 * The `data` of a confirm that answered 200.
 */
interface ConfirmData {
  user: { id: string; email: string; platformRole: string | null }
  accessToken: string
  isNewUser: boolean
  tenant: { name: string; slug: string }
  role: MembershipRole
}

/**
 * Read a 200 confirm's data.
 * @param response - The response.
 * @returns Its `data`.
 */
function confirmData(response: Response): ConfirmData {
  return (response.body as { data: ConfirmData }).data
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
 * The refresh cookie a response set, as `name=value`.
 * @param response - The response.
 * @returns The pair, or undefined.
 */
function refreshCookieOf(response: Response): string | undefined {
  const lines = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  return lines
    .map((line) => line.split(';', 1)[0] ?? '')
    .find((pair) => pair.startsWith(`${REFRESH_COOKIE_NAME}=`))
}

/**
 * A user's refresh rows: whether each is revoked and has an `authenticated_at`.
 * @param userId - The user.
 * @returns One entry per row, oldest first.
 */
async function refreshRows(userId: string): Promise<{ revoked: boolean; recent: boolean }[]> {
  return sql<{ revoked: boolean; recent: boolean }[]>`
    select revoked_at is not null as revoked, authenticated_at is not null as recent
    from user_tokens where user_id = ${userId} and purpose = 'refresh'
    order by created_at, id
  `
}

/**
 * Whether a link row is still unspent: neither revoked nor consumed.
 * @param raw - The raw token.
 * @returns True while it is live.
 */
async function isUnspent(raw: string): Promise<boolean> {
  const [row] = await sql<{ unspent: boolean }[]>`
    select revoked_at is null and consumed_at is null as unspent
    from user_tokens where token_hash = ${hashToken(raw)}
  `
  return row?.unspent === true
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
 * How many link rows a raw token still has: 0 once it was deleted.
 * @param raw - The raw token.
 * @returns The count.
 */
async function linkRowCount(raw: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens where token_hash = ${hashToken(raw)}
  `
  return row?.count ?? 0
}

/**
 * The events emitted for one user.
 * @param userId - The user.
 * @returns The events, in emit order.
 */
function eventsFor(userId: string): DomainEvent[] {
  return emitted.filter((event) => 'userId' in event && event.userId === userId)
}

/**
 * An error body without its per-request id, for comparing two refusals.
 * @param response - The response.
 * @returns The body minus `requestId`.
 */
function refusalBody(response: Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(([key]) => key !== 'requestId')
  )
}

/**
 * Deactivate a fresh target through the staff route, which asks for a recent sign-in.
 * @param accessToken - The caller's bearer.
 * @returns The response.
 */
async function deactivateSomeone(accessToken: string): Promise<Response> {
  const target = await createTrackedUser()
  return request(app)
    .post(`/api/v1/platform/users/${target.id}/deactivate`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ reason: 'invitation confirm step-up check' })
}

/**
 * Switch the maintenance mode for this replica, as a staff change would.
 * @param mode - The mode to switch to.
 */
async function switchMode(mode: 'off' | 'read_only' | 'full'): Promise<void> {
  if (mode === 'off') {
    await resetMaintenanceMode()
  } else {
    await storeMaintenanceMode(mode)
  }
  await reloadMaintenanceMode()
}

beforeEach(async () => {
  await clearRateLimiter('invitation-verify')
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
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

describe('POST /api/v1/invitations/confirm', () => {
  it('signs an existing account in and joins it, as a recent sign-in', async () => {
    // A staff member's account, so a step-up route can prove the session is a recent sign-in.
    const { user: invitee } = await createTrackedStaff('admin', {
      email: uniqueEmail('existing'),
    })
    const { tenant, invitationId, raw } = await invitedWithLink(invitee.email, 'manager')

    const response = await postConfirm({ token: raw, email: invitee.email })

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect((response.body as { message: string }).message).toBe('Invitation accepted.')
    const data = confirmData(response)
    expect(data.isNewUser).toBe(false)
    expect(data.user.id).toBe(invitee.id)
    expect(data.tenant).toStrictEqual({ name: 'Acme Inc', slug: tenant.slug })
    expect(data.role).toBe('manager')
    expect(hasRefreshCookie(response)).toBe(true)
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false, recent: true }])
    const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    expect(membership?.role).toBe('manager')
    expect(await isPending(invitationId)).toBe(false)
    expect(await isUnspent(raw)).toBe(false)
    const audits = await sql<{ metadata: unknown }[]>`
      select metadata from audit_logs
      where action = 'invitation.accepted' and tenant_id = ${tenant.id}
    `
    expect(audits).toEqual([{ metadata: { role: 'manager', invitationId } }])
    expect(eventsFor(invitee.id).map((event) => event.type)).toEqual([
      'invitation_accepted',
      'user_signed_in',
    ])

    const stepUp = await deactivateSomeone(data.accessToken)
    expect(stepUp.status).toBe(200)
  })

  it('creates the staff account, makes it staff and signs it in', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const email = uniqueEmail('staff-new')
    const invitationId = await seedInvitation(platform, inviter, email, 'admin')
    const raw = await issueConfirmLink(email, invitationId, 'apex')

    const response = await postConfirm({ token: raw, email })

    expect(response.status).toBe(200)
    const data = confirmData(response)
    expect(data.isNewUser).toBe(true)
    expect(data.user.email).toBe(email)
    expect(data.user.platformRole).toBe('admin')
    expect(data.tenant.slug).toBe(platform.slug)
    const membership = await userMembershipRepository.findByUserAndTenant(data.user.id, platform.id)
    expect(membership?.role).toBe('admin')
    expect(eventsFor(data.user.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'invitation_accepted',
        'email_verified',
        'user_signed_up',
        'user_signed_in',
      ])
    )

    const stepUp = await deactivateSomeone(data.accessToken)
    expect(stepUp.status).toBe(200)
  })

  it('makes an existing customer account staff from a staff invitation', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const invitee = await createTrackedUser({ email: uniqueEmail('customer-to-staff') })
    const invitationId = await seedInvitation(platform, inviter, invitee.email, 'viewer')
    const raw = await issueConfirmLink(invitee.email, invitationId, 'apex')

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(200)
    const data = confirmData(response)
    expect(data.isNewUser).toBe(false)
    expect(data.user.id).toBe(invitee.id)
    expect(data.user.platformRole).toBe('viewer')
  })

  it('claims a never-verified account, clears its squatter credentials and revokes its earlier sessions', async () => {
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
    await authProviderRepository.create({
      userId: invitee.id,
      provider: 'google',
      providerId: randomUUID(),
    })
    await seedPasskey(invitee.id)
    const { tenant, raw } = await invitedWithLink(invitee.email)

    const response = await postConfirm({ token: raw, email: invitee.email })

    expect(response.status).toBe(200)
    expect(confirmData(response).user.id).toBe(invitee.id)
    expect(confirmData(response).isNewUser).toBe(false)
    expect(await passkeyCount(invitee.id)).toBe(0)
    expect(await refreshRows(invitee.id)).toEqual([
      { revoked: true, recent: true },
      { revoked: false, recent: true },
    ])
    const providers = await authProviderRepository.findByUser(invitee.id)
    expect(providers.map((provider) => provider.provider)).toEqual(['email'])
    const [claimed] = await sql<{ verified: boolean }[]>`
      select email_verified_at is not null as verified from users where id = ${invitee.id}
    `
    expect(claimed?.verified).toBe(true)
    expect(await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeDefined()
  })

  it('keeps an existing membership’s role', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('member') })
    const { tenant, raw } = await invitedWithLink(invitee.email, 'viewer')
    await userMembershipRepository.create({
      userId: invitee.id,
      tenantId: tenant.id,
      role: 'admin',
    })

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(200)
    expect(confirmData(response).role).toBe('admin')
    expect(eventsFor(invitee.id).map((event) => event.type)).toEqual(['user_signed_in'])
  })

  it('refuses a reused link with invitation_invalid and no session', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('reused') })
    const { raw } = await invitedWithLink(invitee.email)
    const first = await postConfirm({ token: raw })
    expect(first.status).toBe(200)

    const second = await postConfirm({ token: raw })

    expect(second.status).toBe(404)
    expect(second.body).toMatchObject(INVALID)
    expect(second.headers['set-cookie']).toBeUndefined()
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false, recent: true }])
  })

  it('refuses an expired link and issues no session', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('expired') })
    const { invitationId, raw } = await invitedWithLink(invitee.email)
    await sql`
      update user_tokens set expires_at = now() - interval '1 second'
      where token_hash = ${hashToken(raw)}
    `

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject(INVALID)
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshRows(invitee.id)).toEqual([])
    expect(await isPending(invitationId)).toBe(true)
  })

  it('refuses unknown and malformed tokens with the same body', async () => {
    for (const body of [
      { token: randomBytes(32).toString('base64url') },
      { token: 'not a token at all' },
      { token: 42 },
      {},
    ]) {
      const response = await postConfirm(body)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
    }
  })

  it('refuses a link whose email names another address, spends nothing, and the right email then joins', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('bound') })
    const { invitationId, raw } = await invitedWithLink(invitee.email)
    const dead = await postConfirm({ token: randomBytes(32).toString('base64url') })

    const mismatched = await postConfirm({ token: raw, email: 'someone-else@example.test' })

    expect(mismatched.status).toBe(404)
    expect(refusalBody(mismatched)).toEqual(refusalBody(dead))
    expect(hasRefreshCookie(mismatched)).toBe(false)
    expect(await isUnspent(raw)).toBe(true)
    expect(await isPending(invitationId)).toBe(true)

    const joined = await postConfirm({ token: raw, email: `  ${invitee.email.toUpperCase()} ` })
    expect(joined.status).toBe(200)
    expect(confirmData(joined).user.id).toBe(invitee.id)
  })

  it('answers a non-string email with the validation 400', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('non-string') })
    const { raw } = await invitedWithLink(invitee.email)

    const response = await postConfirm({ token: raw, email: 42 })

    expect(response.status).toBe(400)
    expect((response.body as { errors?: Record<string, unknown> }).errors).toHaveProperty('email')
    expect(await isUnspent(raw)).toBe(true)
  })

  it('refuses once the invitation was revoked, accepted or expired, or the tenant suspended, and spends nothing', async () => {
    const cases: {
      label: string
      kill: (tenant: Tenant, invitationId: string) => Promise<void>
    }[] = [
      {
        label: 'revoked',
        kill: async (tenant, invitationId) => {
          await invitationRepository.revoke(tenant.id, invitationId)
        },
      },
      {
        label: 'accepted',
        kill: async (_tenant, invitationId) => {
          const other = await createTrackedUser()
          await sql`
              update tenant_invitations set accepted_at = now(), accepted_by = ${other.id}
              where id = ${invitationId}
            `
        },
      },
      {
        label: 'expired',
        kill: async (_tenant, invitationId) => {
          await sql`
              update tenant_invitations set expires_at = now() - interval '1 minute'
              where id = ${invitationId}
            `
        },
      },
      {
        label: 'suspended',
        kill: async (tenant) => {
          await sql`update tenants set lifecycle_state = 'suspended' where id = ${tenant.id}`
        },
      },
    ]
    const suspended: { tenant?: Tenant; raw?: string; inviteeId?: string } = {}

    for (const { label, kill } of cases) {
      const invitee = await createTrackedUser({ email: uniqueEmail(label) })
      const { tenant, invitationId, raw } = await invitedWithLink(invitee.email)
      await kill(tenant, invitationId)

      const response = await postConfirm({ token: raw })

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
      expect(hasRefreshCookie(response)).toBe(false)
      expect(await isUnspent(raw)).toBe(true)
      expect(await refreshRows(invitee.id)).toEqual([])
      if (label === 'suspended') Object.assign(suspended, { tenant, raw, inviteeId: invitee.id })
    }

    await sql`update tenants set lifecycle_state = 'active' where id = ${suspended.tenant?.id ?? ''}`
    const joined = await postConfirm({ token: suspended.raw })
    expect(joined.status).toBe(200)
    expect(confirmData(joined).user.id).toBe(suspended.inviteeId)
  })

  it('still joins after an admin resent the invitation', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('resent') })
    const { tenant, invitationId, raw } = await invitedWithLink(invitee.email)
    // What a resend writes: a new token and expiry on the same invitation.
    await sql`
      update tenant_invitations
      set token_hash = ${hashToken(randomBytes(32).toString('base64url'))},
        expires_at = now() + interval '3 days', last_sent_at = now()
      where id = ${invitationId}
    `

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(200)
    expect(await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeDefined()
  })

  it('refuses a deactivated account and issues no session', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('deactivated'), active: false })
    const { invitationId, raw } = await invitedWithLink(invitee.email)

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject(INVALID)
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshRows(invitee.id)).toEqual([])
    expect(await isUnspent(raw)).toBe(true)
    expect(await isPending(invitationId)).toBe(true)
  })

  it('revokes the session the browser presented', async () => {
    const earlier = await signInByLink(uniqueEmail('someone-else'))
    const invitee = await createTrackedUser({ email: uniqueEmail('presented') })
    const { raw } = await invitedWithLink(invitee.email)

    const response = await postConfirm({ token: raw }, earlier.refreshCookie)

    expect(response.status).toBe(200)
    expect(confirmData(response).user.id).toBe(invitee.id)
    expect(await refreshRows(earlier.userId)).toEqual([{ revoked: true, recent: true }])
  })

  it('is refused in read_only and full, staff included, and the link works once the mode ends', async () => {
    const { user: invitee } = await createTrackedStaff('viewer', {
      email: uniqueEmail('maintenance'),
    })
    const { invitationId, raw } = await invitedWithLink(invitee.email)

    await switchMode('read_only')
    const readOnly = await postConfirm({ token: raw })
    await switchMode('full')
    const full = await postConfirm({ token: raw })

    expect(readOnly.status).toBe(503)
    expect(readOnly.body).toMatchObject({ code: READ_ONLY_MODE_CODE })
    expect(full.status).toBe(503)
    expect(full.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
    expect(await isUnspent(raw)).toBe(true)
    expect(await isPending(invitationId)).toBe(true)

    await switchMode('off')
    const joined = await postConfirm({ token: raw })
    expect(joined.status).toBe(200)
  })

  it.each([
    ['read_only', READ_ONLY_MODE_CODE],
    ['full', MAINTENANCE_MODE_CODE],
  ] as const)(
    'writes no join when %s begins between the peek and the transaction',
    async (mode, code) => {
      const invitee = await createTrackedUser({ email: uniqueEmail(`mode-${mode}`) })
      const { tenant, invitationId, raw } = await invitedWithLink(invitee.email)
      const realFind = TenantInvitationRepository.prototype.findValidById
      /**
       * Stands in for `findValidById`: the lookup succeeds, then the mode switches.
       */
      const switchingFind: typeof realFind = async function (
        this: TenantInvitationRepository,
        ...arguments_
      ) {
        const found = await realFind.apply(this, arguments_)
        await switchMode(mode)
        return found
      }

      let response: Response | undefined
      await withMutatedMethod(
        TenantInvitationRepository.prototype,
        'findValidById',
        switchingFind,
        async () => {
          response = await postConfirm({ token: raw })
        }
      )

      expect(response?.status).toBe(503)
      expect(response?.body).toMatchObject({ code })
      expect(await refreshRows(invitee.id)).toEqual([])
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
      expect(await isUnspent(raw)).toBe(true)
      expect(await isPending(invitationId)).toBe(true)
    }
  )

  it('refuses a disallowed Origin', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('origin') })
    const { raw } = await invitedWithLink(invitee.email)

    const response = await request(app)
      .post('/api/v1/invitations/confirm')
      .set('Origin', 'https://evil.test')
      .send({ token: raw })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    expect(await isUnspent(raw)).toBe(true)
  })

  it('answers 415 for a form body', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('form') })
    const { raw } = await invitedWithLink(invitee.email)

    const response = await request(app)
      .post('/api/v1/invitations/confirm')
      .type('form')
      .send(`token=${raw}`)

    expect(response.status).toBe(415)
    expect(await isUnspent(raw)).toBe(true)
  })

  it('shares the verify limiter: 20 calls across both routes, then 429', async () => {
    for (let index = 0; index < 10; index += 1) {
      const verify = await request(app)
        .post('/api/v1/invitations/verify')
        .send({ token: randomBytes(32).toString('base64url') })
      const confirm = await postConfirm({ token: randomBytes(32).toString('base64url') })
      expect([verify.status, confirm.status]).toEqual([404, 404])
    }

    const limitedConfirm = await postConfirm({ token: randomBytes(32).toString('base64url') })
    const limitedVerify = await request(app)
      .post('/api/v1/invitations/verify')
      .send({ token: randomBytes(32).toString('base64url') })

    expect(limitedConfirm.status).toBe(429)
    expect(limitedVerify.status).toBe(429)
  })

  describe('revocation', () => {
    it('a deactivation revokes a live invitation link, and its confirm answers 404', async () => {
      const { user: admin } = await createTrackedStaff('admin')
      const invitee = await createTrackedUser({ email: uniqueEmail('revoke-deactivate') })
      const { raw } = await invitedWithLink(invitee.email)

      await deactivateUser({ userId: admin.id }, invitee.id, 'invitation link revocation test')
      await sql`update users set active = true where id = ${invitee.id}`

      expect(await isUnspent(raw)).toBe(false)
      const response = await postConfirm({ token: raw })
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
    })

    it('a staff sign-out revokes a live invitation link, and its confirm answers 404', async () => {
      const { user: admin } = await createTrackedStaff('admin')
      const invitee = await createTrackedUser({ email: uniqueEmail('revoke-sign-out') })
      const { raw } = await invitedWithLink(invitee.email)

      await signOutUser({ userId: admin.id }, invitee.id, 'invitation link revocation test')

      expect(await isUnspent(raw)).toBe(false)
      const refused = await postConfirm({ token: raw })
      expect(refused.status).toBe(404)
    })

    it('signing out of the other sessions revokes a live invitation link, and its confirm answers 404', async () => {
      const invitee = await createTrackedUser({ email: uniqueEmail('revoke-others') })
      const sessionId = randomUUID()
      await issueRefreshToken(invitee.id, sessionId)
      const { raw } = await invitedWithLink(invitee.email)

      await revokeOtherSessions(invitee.id, sessionId)

      expect(await isUnspent(raw)).toBe(false)
      const refused = await postConfirm({ token: raw })
      expect(refused.status).toBe(404)
    })
  })

  it('a purge deletes the address’s invitation links', async () => {
    const email = uniqueEmail('purge')
    const { raw } = await invitedWithLink(email)

    const deleted = await db.transaction((tx) =>
      userTokenRepository.deleteForEmail(email, new Date(Date.now() + HOUR_MS), tx)
    )

    expect(deleted).toBe(1)
    expect(await linkRowCount(raw)).toBe(0)
  })

  it('deleting the invitation deletes its links', async () => {
    const email = uniqueEmail('cascade')
    const { invitationId, raw } = await invitedWithLink(email)

    await sql`delete from tenant_invitations where id = ${invitationId}`

    expect(await linkRowCount(raw)).toBe(0)
  })

  it('a claimed invitation link leaves refresh paths alone', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('refresh-alone') })
    const sessionId = randomUUID()
    const earlier = await issueRefreshToken(invitee.id, sessionId)
    const { raw } = await invitedWithLink(invitee.email)

    const confirmed = await postConfirm({ token: raw })
    expect(confirmed.status).toBe(200)

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${earlier.raw}`)
      .send({})
    expect(rotated.status).toBe(200)
    expect(refreshCookieOf(rotated)).toBeDefined()
    expect(await userTokenRepository.isSessionKilled(sessionId, hashToken(earlier.raw))).toBe(false)
  })

  it('makes the staff role from the invitation, not from a pre-check', async () => {
    // A staff invitee is not staff until the join: Apex is authorised by the invitation's tenant.
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const invitee = await createTrackedUser({ email: uniqueEmail('not-yet-staff') })
    const invitationId = await seedInvitation(platform, inviter, invitee.email, 'editor')
    const raw = await issueConfirmLink(invitee.email, invitationId, 'apex')

    const response = await postConfirm({ token: raw })

    expect(response.status).toBe(200)
    expect(confirmData(response).user.platformRole).toBe('editor')
  })

  it('refuses a link whose app does not match the invitation’s tenant, and spends nothing', async () => {
    // Defence in depth: the follow-up always mails apex for staff and web otherwise.
    const invitee = await createTrackedUser({ email: uniqueEmail('wrong-app') })
    const { tenant, owner } = await createTenant()
    const invitationId = await seedInvitation(tenant, owner, invitee.email)
    const raw = await issueConfirmLink(invitee.email, invitationId, 'apex')
    const platform = await platformTenant()
    const staffEmail = uniqueEmail('wrong-app-staff')
    const staffInvite = await seedInvitation(platform, owner, staffEmail)
    const staffRaw = await issueConfirmLink(staffEmail, staffInvite, 'web')

    for (const token of [raw, staffRaw]) {
      const response = await postConfirm({ token })
      expect(response.status).toBe(404)
      expect(response.body).toMatchObject(INVALID)
      expect(await isUnspent(token)).toBe(true)
    }
    expect(await isPending(invitationId)).toBe(true)
    expect(await isPending(staffInvite)).toBe(true)
  })
})
