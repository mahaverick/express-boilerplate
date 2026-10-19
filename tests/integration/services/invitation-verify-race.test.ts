/**
 * @file Races on `POST /api/v1/invitations/verify`: two concurrent clicks on
 * one link for an address with no account create one account and one
 * membership, and the loser gets the generic `invitation_invalid` with no
 * session; a deactivation that commits while a click is on its way to the
 * user-row lock wins, so the click answers `invitation_invalid` and issues
 * no session.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const { name: REFRESH_COOKIE_NAME } = testRefreshCookie()

const HOUR_MS = 60 * 60 * 1000

/**
 * Every address this file used, for `afterEach` to delete the accounts a click created.
 */
const usedEmails: string[] = []

/**
 * Every tenant this file created, for `afterEach` to delete.
 */
const createdTenantIds: string[] = []

/**
 * A customer tenant owned by a fresh user, with one pending editor
 * invitation for `email`.
 * @param email - The invited address.
 * @returns The tenant and the invitation's raw token.
 */
async function invitedTo(email: string): Promise<{ tenant: Tenant; rawToken: string }> {
  const owner: User = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `invite-race-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  const rawToken = randomBytes(32).toString('base64url')
  await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'editor',
        tokenHash: hashToken(rawToken),
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
      tx
    )
  )
  return { tenant, rawToken }
}

/**
 * Post an invitation verify.
 * @param token - The raw token.
 * @returns The response.
 */
function postVerify(token: string): Promise<Response> {
  return request(app).post('/api/v1/invitations/verify').send({ token })
}

/**
 * Whether the response set the refresh cookie.
 * @param response - The response.
 * @returns True when a `Set-Cookie` line names the refresh cookie.
 */
function hasRefreshCookie(response: Response | undefined): boolean {
  const lines = (response?.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  return lines.some((line) => line.startsWith(`${REFRESH_COOKIE_NAME}=`))
}

afterEach(async () => {
  const client = await getRedis()
  const keys: string[] = []
  const batches = client.scanIterator({ MATCH: `${redisKey('rl', 'invitation-verify')}:*` })
  for await (const batch of batches) {
    keys.push(...batch)
  }
  if (keys.length > 0) await client.del(keys)
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

describe('invitation verify races', () => {
  it('one of two concurrent verifies joins and the other creates no account', async () => {
    const email = `invite-race-${randomUUID()}@example.test`
    usedEmails.push(email)
    const { tenant, rawToken } = await invitedTo(email)

    const responses = await Promise.all([postVerify(rawToken), postVerify(rawToken)])

    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 404,
    ])
    const loser = responses.find((response) => response.status === 404)
    expect(loser?.body).toMatchObject({ code: 'invitation_invalid' })
    expect(hasRefreshCookie(loser)).toBe(false)
    const users = await sql<{ id: string }[]>`
      select id from users where lower(email) = ${email}
    `
    expect(users).toHaveLength(1)
    const memberships = await sql<{ count: number }[]>`
      select count(*)::int as count from user_memberships where tenant_id = ${tenant.id}
        and user_id = ${users[0]?.id ?? ''}
    `
    expect(memberships[0]?.count).toBe(1)
    const refresh = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${users[0]?.id ?? ''} and purpose = 'refresh'
    `
    expect(refresh[0]?.count).toBe(1)
  })

  it('answers invitation_invalid, not 409, when the address is taken mid-click, and leaves the link usable', async () => {
    const email = `invite-race-taken-${randomUUID()}@example.test`
    usedEmails.push(email)
    const { tenant, rawToken } = await invitedTo(email)
    const seeded: { id?: string } = {}
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realCreate = UserRepository.prototype.create
    /**
     * Stands in for `UserRepository.create`: just before the click's insert, a
     * registration on another connection commits an unverified account for the address.
     */
    const racingCreate: typeof realCreate = async function (this: UserRepository, ...arguments_) {
      const [values] = arguments_
      if (seeded.id === undefined && values.email === email) {
        const squatter = await realCreate.call(this, { email, passwordHash: 'not-a-real-hash' })
        seeded.id = squatter.id
      }
      return realCreate.apply(this, arguments_)
    }

    let refused: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'create', racingCreate, async () => {
      refused = await postVerify(rawToken)
    })

    expect(refused?.status).toBe(404)
    expect(refused?.body).toMatchObject({ code: 'invitation_invalid' })
    expect(hasRefreshCookie(refused)).toBe(false)
    // The lost race rolled back before the claim: the next click claims the account and joins.
    const retried = await postVerify(rawToken)
    expect(retried.status).toBe(200)
    expect((retried.body as { data: { user: { id: string } } }).data.user.id).toBe(seeded.id)
    expect(
      await userMembershipRepository.findByUserAndTenant(seeded.id ?? '', tenant.id)
    ).toBeDefined()
  })

  it('a deactivation committed mid-verify wins', async () => {
    const invitee = await createTrackedUser()
    const { tenant, rawToken } = await invitedTo(invitee.email)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realLock = UserRepository.prototype.lockById
    /**
     * Stands in for `UserRepository.lockById`: just before the click locks the
     * invitee's row, a deactivation commits on another connection.
     */
    const deactivatingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
      const [id, mode] = arguments_
      if (mode === 'share' && id === invitee.id) {
        await sql`update users set active = false where id = ${invitee.id}`
      }
      return realLock.apply(this, arguments_)
    }

    let response: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'lockById', deactivatingLock, async () => {
      response = await postVerify(rawToken)
    })

    expect(response?.status).toBe(404)
    expect(response?.body).toMatchObject({ code: 'invitation_invalid' })
    expect(hasRefreshCookie(response)).toBe(false)
    const refresh = await sql<{ count: number }[]>`
      select count(*)::int as count from user_tokens
      where user_id = ${invitee.id} and purpose = 'refresh'
    `
    expect(refresh[0]?.count).toBe(0)
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
  })
})
