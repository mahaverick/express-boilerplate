/**
 * @file `POST /api/v1/invitations/verify`: one click on an invitation link.
 * A customer invitation to an address with no account signs the invitee in
 * and joins them in that click, creating a verified account. Any other
 * click (an address that has an account, or any staff invitation) answers
 * `202` "Check your inbox", spends nothing, sets no cookie, and mails a
 * 15-minute confirm link after the reply. Every dead link answers the
 * generic `invitation_invalid`. No Worker runs; the file reads rows and
 * queued jobs straight from the database and the queue.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createApp } from '@/app'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { emailQueueFor, type EmailJobData } from '@/jobs/email.job'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserTokenRepository } from '@/repositories/user-token.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { addressDigest } from '@/services/mail-cooldown.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { closeQueue, getAuthEmailQueue, getEmailQueue } from '@/services/queue.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken, issueRefreshToken } from '@/services/session.service'
import { spendSignInLinkBudget } from '@/services/sign-in-link-limit.service'
import { requestSignInLink } from '@/services/sign-in-link.service'
import { verifyInvitation } from '@/services/tenant-invitation.service'
import { INVITATION_CONFIRM_TEMPLATE_KEY } from '@/templates/email/invitation-confirm.template'
import type { DomainEvent } from '@/types/domain-event'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { deferred } from '../../helpers/lock-probe'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff, platformTenant } from '../../helpers/platform-staff'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { queuedJobs } from '../../helpers/queue-jobs'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'
import { clearRateLimiter, signInByLink } from '../../helpers/sign-in'
import { waitUntil } from '../../helpers/timing'

vi.mock('@/services/sign-in-link-limit.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sign-in-link-limit.service')>()
  return { ...actual, spendSignInLinkBudget: vi.fn(actual.spendSignInLinkBudget) }
})

const app = createApp()
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
 * accounts a click created, the links minted and the messages queued.
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

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await closeQueue()
})

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
 * A customer invitation to `email`, from a fresh tenant.
 * @param email - The invited address.
 * @param role - The offered role.
 * @returns The tenant, the raw token and the invitation's id.
 */
async function customerInvitation(
  email: string,
  role: MembershipRole = 'editor'
): Promise<{ tenant: Tenant; rawToken: string; invitationId: string }> {
  const { tenant, owner } = await createTenant()
  return { tenant, ...(await seedInvitation(tenant, owner, email, role)) }
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
 * The `invitation_link` rows of one address, oldest first.
 * @param email - The address.
 * @returns The columns these tests read.
 */
async function confirmLinks(email: string): Promise<
  {
    userId: string | null
    app: string
    invitationId: string | null
    revoked: boolean
  }[]
> {
  return sql<
    { userId: string | null; app: string; invitationId: string | null; revoked: boolean }[]
  >`
    select user_id as "userId", app, invitation_id as "invitationId",
      revoked_at is not null as revoked
    from user_tokens where email = ${email} and purpose = 'invitation_link'
    order by created_at, id
  `
}

/**
 * The confirm mails queued for one address.
 * @param email - The recipient.
 * @returns Their job payloads.
 */
async function confirmJobs(email: string): Promise<EmailJobData[]> {
  const jobs = await queuedJobs<EmailJobData>(emailQueueFor(INVITATION_CONFIRM_TEMPLATE_KEY))
  return jobs
    .map((job) => job.data)
    .filter((data) => data.to === email && data.templateKey === INVITATION_CONFIRM_TEMPLATE_KEY)
}

/**
 * Wait until one confirm mail is queued for an address, after the reply.
 * @param email - The recipient.
 * @returns The queued mail.
 */
async function waitForConfirmJob(email: string): Promise<EmailJobData> {
  const [job] = await waitUntil(
    async () => {
      const jobs = await confirmJobs(email)
      return jobs.length > 0 ? jobs : undefined
    },
    { message: `the confirm mail to ${email}` }
  )
  if (!job) throw new Error('no confirm mail')
  return job
}

/**
 * Run a verify at the service level and await its follow-up, for tests of
 * what the follow-up mails or skips.
 * @param rawToken - The raw invitation token.
 * @returns The outcome's kind.
 */
async function verifyAndFollowUp(rawToken: string): Promise<string> {
  const outcome = await verifyInvitation(rawToken)
  if (outcome.kind === 'confirm') await outcome.followUp()
  return outcome.kind
}

/**
 * Release one address's confirm-mail cooldown for one invitation, as its expiry would.
 * @param email - The address.
 * @param invitationId - The invitation the cooldown is for.
 */
async function releaseConfirmCooldown(email: string, invitationId: string): Promise<void> {
  const redis = await getRedis()
  await redis.del(redisKey(`invitation-confirm:${invitationId}`, addressDigest(email)))
}

/**
 * Delete every confirm-mail cooldown key under this worker's prefix, so a
 * cooldown one test claimed does not hold back the next test's mail.
 */
async function clearConfirmCooldowns(): Promise<void> {
  const redis = await getRedis()
  const keys: string[] = []
  const batches = redis.scanIterator({ MATCH: `${redisKey('invitation-confirm')}:*` })
  for await (const batch of batches) keys.push(...batch)
  if (keys.length > 0) await redis.del(keys)
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
 * Switch the maintenance mode for this replica, as a staff change would.
 * @param mode - The mode to switch to.
 */
async function switchMode(mode: 'read_only' | 'full'): Promise<void> {
  await storeMaintenanceMode(mode)
  await reloadMaintenanceMode()
}

beforeEach(async () => {
  await clearRateLimiter('invitation-verify')
})

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
  vi.mocked(spendSignInLinkBudget).mockClear()
  await truncateAuditLogs()
  if (createdTenantIds.length > 0) {
    await sql`delete from tenants where id = any(${createdTenantIds})`
    createdTenantIds.length = 0
  }
  if (usedEmails.length > 0) {
    await sql`delete from email_messages where recipient = any(${usedEmails})`
    await sql`delete from user_tokens where email = any(${usedEmails})`
    await sql`delete from users where lower(email) = any(${usedEmails})`
    await clearConfirmCooldowns()
    usedEmails.length = 0
  }
  await deleteTrackedUsers()
})

describe('POST /api/v1/invitations/verify', () => {
  it('creates a verified account, joins with the invited role and signs in', async () => {
    const email = uniqueEmail('new')
    const { tenant, rawToken, invitationId } = await customerInvitation(email, 'manager')

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
    expect(eventsFor(data.user.id).map((event) => event.type)).toEqual(
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
      expect.objectContaining({
        type: 'invitation_accepted',
        tenantId: tenant.id,
        role: 'manager',
        wasFirstMember: false,
      })
    )
    expect(await confirmLinks(email)).toEqual([])
  })

  it('issues a one-click session that does not count as a recent sign-in', async () => {
    const email = uniqueEmail('stale')
    const { rawToken } = await customerInvitation(email)

    const response = await postVerify(rawToken)
    expect(response.status).toBe(200)
    const data = verifyData(response)

    const [row] = await sql<{ authenticated: boolean }[]>`
      select authenticated_at is not null as authenticated from user_tokens
      where user_id = ${data.user.id} and purpose = 'refresh'
    `
    expect(row?.authenticated).toBe(false)
    const [, payload] = data.accessToken.split('.', 2)
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as object
    expect(claims).not.toHaveProperty('auth_time')
  })

  it('joins in one click for an address whose only account was deleted', async () => {
    const gone = await createTrackedUser({ email: uniqueEmail('soft-deleted') })
    await sql`update users set deleted_at = now() where id = ${gone.id}`
    const { rawToken } = await customerInvitation(gone.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(200)
    expect(verifyData(response).isNewUser).toBe(true)
    expect(verifyData(response).user.id).not.toBe(gone.id)
  })

  it('mails a confirm link instead of signing in an existing verified account', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('existing'), firstName: 'Grace' })
    const presented = await issueRefreshToken(invitee.id, randomUUID())
    const { tenant, rawToken, invitationId } = await customerInvitation(invitee.email)

    const response = await postVerify(rawToken, `${REFRESH_COOKIE_NAME}=${presented.raw}`)

    expect(response.status).toBe(202)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toEqual({
      success: true,
      message: 'Check your inbox to finish joining.',
      statusCode: 202,
      data: { confirmationSent: true, email: invitee.email },
    })
    // The presented session survives, and no new one exists.
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false }])
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    expect(await isPending(invitationId)).toBe(true)
    const preview = await request(app).post('/api/v1/invitations/preview').send({ token: rawToken })
    expect(preview.status).toBe(200)

    const job = await waitForConfirmJob(invitee.email)
    expect(job.userId).toBe(invitee.id)
    if (job.templateKey !== INVITATION_CONFIRM_TEMPLATE_KEY) throw new Error('wrong template')
    expect(job.variables).toMatchObject({
      firstName: 'Grace',
      tenantName: 'Acme Inc',
      role: 'editor',
      expiresInMinutes: '15',
      expiresAt: expect.stringMatching(/^\d{2}:\d{2} UTC on \d{1,2} [A-Z][a-z]+ \d{4}$/) as unknown,
    })
    const link = new URL(job.variables.confirmUrl)
    expect(link.pathname).toBe('/invitations/confirm')
    expect(link.searchParams.get('email')).toBe(invitee.email)
    expect(link.searchParams.get('token')).toMatch(/^[\w-]{43}$/)
    // The invitation's own token is never mailed in the confirm link.
    expect(job.variables.confirmUrl).not.toContain(rawToken)
    expect(await confirmLinks(invitee.email)).toEqual([
      { userId: null, app: 'web', invitationId, revoked: false },
    ])
    const [message] = await sql<{ tenantId: string; invitationId: string; linkApp: string }[]>`
      select tenant_id as "tenantId", invitation_id as "invitationId", link_app as "linkApp"
      from email_messages
      where recipient = ${invitee.email} and template_key = ${INVITATION_CONFIRM_TEMPLATE_KEY}
    `
    expect(message).toEqual({ tenantId: tenant.id, invitationId, linkApp: 'web' })

    // The mailed link signs in and joins.
    const confirmed = await request(app)
      .post('/api/v1/invitations/confirm')
      .send({ token: link.searchParams.get('token'), email: link.searchParams.get('email') })
    expect(confirmed.status).toBe(200)
    expect(verifyData(confirmed).user.id).toBe(invitee.id)
    expect(await isPending(invitationId)).toBe(false)
  })

  it('mails a confirm link for a never-verified account and claims nothing', async () => {
    const invitee = await createTrackedUser({
      email: uniqueEmail('never-verified'),
      verified: false,
    })
    await issueRefreshToken(invitee.id, randomUUID())
    const { rawToken, invitationId } = await customerInvitation(invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(202)
    expect(hasRefreshCookie(response)).toBe(false)
    await waitForConfirmJob(invitee.email)
    const untouched = await userRepository.findById(invitee.id)
    expect(untouched?.emailVerifiedAt).toBeNull()
    // Its earlier session stays live until the confirm claims the account.
    expect(await refreshRows(invitee.id)).toEqual([{ revoked: false }])
    expect(await isPending(invitationId)).toBe(true)
  })

  it('mails a confirm link for a staff invitation to a new address and creates no account', async () => {
    const platform = await platformTenant()
    const inviter = await createTrackedUser()
    const email = uniqueEmail('staff')
    const { rawToken, invitationId } = await seedInvitation(platform, inviter, email, 'admin')

    const response = await postVerify(rawToken)

    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ data: { confirmationSent: true, email } })
    expect(hasRefreshCookie(response)).toBe(false)
    const job = await waitForConfirmJob(email)
    expect(job.userId).toBe('')
    if (job.templateKey !== INVITATION_CONFIRM_TEMPLATE_KEY) throw new Error('wrong template')
    expect(job.variables.firstName).toBe('there')
    expect(await userCount(email)).toBe(0)
    expect(await isPending(invitationId)).toBe(true)
    expect(await confirmLinks(email)).toEqual([
      { userId: null, app: 'apex', invitationId, revoked: false },
    ])
  })

  it('still answers invitation_invalid for a deactivated invitee and mails nothing', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('deactivated'), active: false })
    const { tenant, rawToken, invitationId } = await customerInvitation(invitee.email)

    const response = await postVerify(rawToken)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject(INVALID)
    expect(response.headers['set-cookie']).toBeUndefined()
    await expect(verifyInvitation(rawToken)).rejects.toMatchObject({ statusCode: 404 })
    expect(await confirmLinks(invitee.email)).toEqual([])
    expect(await confirmJobs(invitee.email)).toEqual([])
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    expect(await isPending(invitationId)).toBe(true)
  })

  it('mails one confirm link per cooldown and still answers 202', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('cooldown') })
    const { rawToken } = await customerInvitation(invitee.email)

    const first = await postVerify(rawToken)
    await waitForConfirmJob(invitee.email)
    const second = await postVerify(rawToken)
    expect(await verifyAndFollowUp(rawToken)).toBe('confirm')

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(second.text).toBe(first.text)
    expect(await confirmJobs(invitee.email)).toHaveLength(1)
    expect(await confirmLinks(invitee.email)).toHaveLength(1)
  })

  it('sends the confirm link even right after a sign-in link to the same address', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('separate-scopes') })
    const { rawToken } = await customerInvitation(invitee.email)
    await requestSignInLink({ email: invitee.email, app: 'web' })()

    expect(await verifyAndFollowUp(rawToken)).toBe('confirm')

    expect(await confirmLinks(invitee.email)).toHaveLength(1)
    expect(await confirmJobs(invitee.email)).toHaveLength(1)
  })

  it('mails nothing once the daily budget is spent', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('budget') })
    const { rawToken } = await customerInvitation(invitee.email)
    vi.mocked(spendSignInLinkBudget).mockResolvedValueOnce('exhausted')

    const outcome = await verifyInvitation(rawToken)
    if (outcome.kind !== 'confirm') throw new Error('expected the confirm branch')
    await outcome.followUp()

    expect(vi.mocked(spendSignInLinkBudget)).toHaveBeenCalledWith(invitee.email)
    expect(await confirmLinks(invitee.email)).toEqual([])
    expect(await confirmJobs(invitee.email)).toEqual([])
  })

  it('revokes the earlier confirm link when a new one is issued', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('supersede') })
    const { rawToken, invitationId } = await customerInvitation(invitee.email)

    await verifyAndFollowUp(rawToken)
    await releaseConfirmCooldown(invitee.email, invitationId)
    await verifyAndFollowUp(rawToken)

    const links = await confirmLinks(invitee.email)
    expect(links.map((row) => row.revoked)).toEqual([true, false])
    expect(await confirmJobs(invitee.email)).toHaveLength(2)
  })

  it('mails a confirm link for each of two invitations to one address, and both join', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('two-invitations') })
    const first = await customerInvitation(invitee.email)
    const second = await customerInvitation(invitee.email)

    // Join on B a moment after Join on A: inside A's cooldown.
    expect(await verifyAndFollowUp(first.rawToken)).toBe('confirm')
    expect(await verifyAndFollowUp(second.rawToken)).toBe('confirm')

    const jobs = await confirmJobs(invitee.email)
    expect(jobs).toHaveLength(2)
    const links = await confirmLinks(invitee.email)
    expect(links.map((row) => [row.invitationId, row.revoked])).toEqual([
      [first.invitationId, false],
      [second.invitationId, false],
    ])
    const tokens = jobs.map((job) => {
      if (job.templateKey !== INVITATION_CONFIRM_TEMPLATE_KEY) throw new Error('wrong template')
      return new URL(job.variables.confirmUrl).searchParams.get('token')
    })
    for (const token of tokens) {
      const confirmed = await request(app).post('/api/v1/invitations/confirm').send({ token })
      expect(confirmed.status).toBe(200)
    }
    for (const { tenant } of [first, second]) {
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeDefined()
    }
  })

  it.each(['customer account', 'staff account'] as const)(
    'mails a confirm link for a staff invitation to an existing %s and grants nothing',
    async (kind) => {
      const platform = await platformTenant()
      const inviter = await createTrackedUser()
      const invitee = await createTrackedUser({ email: uniqueEmail('staff-existing') })
      if (kind === 'staff account') await makeStaff(invitee.id, 'viewer')
      const presented = await issueRefreshToken(invitee.id, randomUUID())
      const { rawToken, invitationId } = await seedInvitation(
        platform,
        inviter,
        invitee.email,
        'admin'
      )

      const response = await postVerify(rawToken, `${REFRESH_COOKIE_NAME}=${presented.raw}`)

      expect(response.status).toBe(202)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(await refreshRows(invitee.id)).toEqual([{ revoked: false }])
      const membership = await userMembershipRepository.findByUserAndTenant(invitee.id, platform.id)
      expect(membership?.role).toBe(kind === 'staff account' ? 'viewer' : undefined)
      expect(await isPending(invitationId)).toBe(true)
      await waitForConfirmJob(invitee.email)
      expect(await confirmLinks(invitee.email)).toEqual([
        { userId: null, app: 'apex', invitationId, revoked: false },
      ])
    }
  )

  it('replies before the mail work', async () => {
    const invitee = await createTrackedUser({ email: uniqueEmail('before-mail') })
    const { rawToken } = await customerInvitation(invitee.email)
    const reached = deferred()
    const release = deferred()
    const realLock = UserTokenRepository.prototype.lockLinkIssue
    /**
     * Stands in for `lockLinkIssue`, which only the follow-up's `issueLinkToken` calls: it
     * signals, then holds the issue until released.
     */
    const blockingLock: typeof realLock = async function (
      this: UserTokenRepository,
      ...arguments_
    ) {
      reached.resolve()
      await release.promise
      return realLock.apply(this, arguments_)
    }

    await withMutatedMethod(
      UserTokenRepository.prototype,
      'lockLinkIssue',
      blockingLock,
      async () => {
        try {
          const response = await postVerify(rawToken)
          expect(response.status).toBe(202)
          // The reply is in hand while the follow-up's issue has not run.
          await reached.promise
          expect(await confirmLinks(invitee.email)).toEqual([])
        } finally {
          release.resolve()
        }
      }
    )
    await waitForConfirmJob(invitee.email)
  })

  it('answers invitation_invalid for a used link, even for the invitee, and issues no session', async () => {
    const email = uniqueEmail('used')
    const { rawToken } = await customerInvitation(email)
    const first = await postVerify(rawToken)
    expect(first.status).toBe(200)
    const inviteeId = verifyData(first).user.id
    const firstCookie = ((first.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
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
      expect(await confirmLinks(email)).toEqual([])
    }
  })

  it('revokes the session the browser presented on a one-click join', async () => {
    const signedIn = await signInByLink(uniqueEmail('someone-else'))
    const email = uniqueEmail('presented')
    const { tenant, rawToken } = await customerInvitation(email)

    const response = await request(app)
      .post('/api/v1/invitations/verify')
      .set('Cookie', signedIn.refreshCookie)
      .set('Authorization', `Bearer ${signedIn.accessToken}`)
      .send({ token: rawToken })

    expect(response.status).toBe(200)
    const data = verifyData(response)
    expect(data.user.email).toBe(email)
    expect(await refreshRows(signedIn.userId)).toEqual([{ revoked: true }])
    expect(await refreshRows(data.user.id)).toEqual([{ revoked: false }])
    expect(
      await userMembershipRepository.findByUserAndTenant(signedIn.userId, tenant.id)
    ).toBeUndefined()
  })

  it('refuses a disallowed Origin', async () => {
    const { rawToken, invitationId } = await customerInvitation(uniqueEmail('origin'))

    const response = await request(app)
      .post('/api/v1/invitations/verify')
      .set('Origin', 'https://evil.test')
      .send({ token: rawToken })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    expect(await isPending(invitationId)).toBe(true)
  })

  it('answers 415 for a form body', async () => {
    const { rawToken, invitationId } = await customerInvitation(uniqueEmail('form'))

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

  it.each(['new address', 'existing account'] as const)(
    'is refused in read_only and full with the maintenance codes for a %s, and mails nothing',
    async (kind) => {
      const email = uniqueEmail('maintenance')
      if (kind === 'existing account') await createTrackedUser({ email })
      const { rawToken, invitationId } = await customerInvitation(email)
      const accounts = await userCount(email)

      await switchMode('read_only')
      const readOnly = await postVerify(rawToken)
      await switchMode('full')
      const full = await postVerify(rawToken)

      expect(readOnly.status).toBe(503)
      expect(readOnly.body).toMatchObject({ code: READ_ONLY_MODE_CODE })
      expect(full.status).toBe(503)
      expect(full.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
      expect(await userCount(email)).toBe(accounts)
      expect(await isPending(invitationId)).toBe(true)
      await expect(verifyInvitation(rawToken)).rejects.toMatchObject({ statusCode: 503 })
      expect(await confirmLinks(email)).toEqual([])
      expect(await confirmJobs(email)).toEqual([])
    }
  )
})
