/**
 * @file Races on `POST /api/v1/invitations/verify`: two concurrent clicks on
 * one link, for an address with no account or for an existing one, join once,
 * and the loser gets the generic `invitation_invalid` with no session; a
 * deactivation or delete that commits while a click is on its way to a
 * user-row lock wins with the same answer; and a maintenance mode that begins
 * after the route's gate is refused with the code sign-in verify answers,
 * before anything is written.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { makeStaff } from '../../helpers/platform-staff'
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

/**
 * Whether the invitation behind a raw token is still pending.
 * @param rawToken - The raw token.
 * @returns True while it is neither accepted nor revoked.
 */
async function isPendingToken(rawToken: string): Promise<boolean> {
  const [row] = await sql<{ pending: boolean }[]>`
    select accepted_at is null and revoked_at is null as pending
    from tenant_invitations where token_hash = ${hashToken(rawToken)}
  `
  return row?.pending === true
}

/**
 * How many refresh rows a user holds.
 * @param userId - The user.
 * @returns The count.
 */
async function refreshCount(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from user_tokens
    where user_id = ${userId} and purpose = 'refresh'
  `
  return row?.count ?? 0
}

/**
 * Switch the maintenance mode for this replica, as a staff change would.
 * @param mode - The mode to switch to.
 */
async function switchMode(mode: 'read_only' | 'full'): Promise<void> {
  await storeMaintenanceMode(mode)
  await reloadMaintenanceMode()
}

afterEach(async () => {
  await resetMaintenanceMode()
  await reloadMaintenanceMode()
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
     * write on another connection commits an unverified account for the address.
     */
    const racingCreate: typeof realCreate = async function (this: UserRepository, ...arguments_) {
      const [values] = arguments_
      if (seeded.id === undefined && values.email === email) {
        const squatter = await realCreate.call(this, { email })
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

  it('joins once when an existing invitee clicks twice at once', async () => {
    const invitee = await createTrackedUser()
    const { tenant, rawToken } = await invitedTo(invitee.email)

    const responses = await Promise.all([postVerify(rawToken), postVerify(rawToken)])

    expect(responses.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
      200, 404,
    ])
    const loser = responses.find((response) => response.status === 404)
    expect(loser?.body).toMatchObject({ code: 'invitation_invalid' })
    expect(hasRefreshCookie(loser)).toBe(false)
    const memberships = await sql<{ count: number }[]>`
      select count(*)::int as count from user_memberships
      where tenant_id = ${tenant.id} and user_id = ${invitee.id}
    `
    expect(memberships[0]?.count).toBe(1)
    expect(await refreshCount(invitee.id)).toBe(1)
  })

  it.each([
    ['read_only', READ_ONLY_MODE_CODE],
    ['full', MAINTENANCE_MODE_CODE],
  ] as const)(
    'refuses with %s’s code when that mode begins after the route gate, and writes nothing',
    async (mode, code) => {
      const email = `invite-race-mode-${randomUUID()}@example.test`
      usedEmails.push(email)
      const { rawToken } = await invitedTo(email)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realFind = TenantInvitationRepository.prototype.findValidByTokenHash
      /**
       * Stands in for `findValidByTokenHash`: the lookup succeeds, then the mode switches.
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
        'findValidByTokenHash',
        switchingFind,
        async () => {
          response = await postVerify(rawToken)
        }
      )

      expect(response?.status).toBe(503)
      expect(response?.body).toMatchObject({ code })
      expect(hasRefreshCookie(response)).toBe(false)
      const users = await sql`select id from users where lower(email) = ${email}`
      expect(users).toHaveLength(0)
      expect(await isPendingToken(rawToken)).toBe(true)
    }
  )

  it('answers MAINTENANCE_MODE, as sign-in verify does, when assertSignInAllowed refuses the account, and claims nothing', async () => {
    const invitee = await createTrackedUser({ verified: false })
    const { rawToken } = await invitedTo(invitee.email)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realFind = UserRepository.prototype.findByEmail
    /**
     * Stands in for `UserRepository.findByEmail`: once the account is read, `full` begins.
     */
    const switchingFind: typeof realFind = async function (this: UserRepository, ...arguments_) {
      const found = await realFind.apply(this, arguments_)
      if (arguments_[0] === invitee.email) await switchMode('full')
      return found
    }

    let response: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'findByEmail', switchingFind, async () => {
      response = await postVerify(rawToken)
    })

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
    expect(hasRefreshCookie(response)).toBe(false)
    // Refused before the claim: the never-verified account is left as it was.
    const untouched = await sql<{ verified: boolean }[]>`
      select email_verified_at is not null as verified from users where id = ${invitee.id}
    `
    expect(untouched[0]?.verified).toBe(false)
    expect(await isPendingToken(rawToken)).toBe(true)
  })

  it('writes no join when read_only begins during the never-verified claim', async () => {
    const invitee = await createTrackedUser({ verified: false })
    const { tenant, rawToken } = await invitedTo(invitee.email)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
    const realLock = UserRepository.prototype.lockById
    /**
     * Stands in for `UserRepository.lockById`: the claim's first lock switches the mode.
     */
    const switchingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
      const [id, mode] = arguments_
      if (mode === 'no key update' && id === invitee.id) await switchMode('read_only')
      return realLock.apply(this, arguments_)
    }

    let response: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'lockById', switchingLock, async () => {
      response = await postVerify(rawToken)
    })

    expect(response?.status).toBe(503)
    expect(response?.body).toMatchObject({ code: READ_ONLY_MODE_CODE })
    expect(hasRefreshCookie(response)).toBe(false)
    expect(await refreshCount(invitee.id)).toBe(0)
    expect(
      await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
    ).toBeUndefined()
    expect(await isPendingToken(rawToken)).toBe(true)
  })

  it.each(['non-staff', 'staff'] as const)(
    'writes no join when full begins during the never-verified claim of a %s invitee',
    async (kind) => {
      // A staff invitee passes assertSignInAllowed in full; only the re-check after the claim refuses the join.
      const invitee = await createTrackedUser({ verified: false })
      if (kind === 'staff') await makeStaff(invitee.id, 'viewer')
      const { tenant, rawToken } = await invitedTo(invitee.email)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realLock = UserRepository.prototype.lockById
      /**
       * Stands in for `UserRepository.lockById`: the claim's first lock switches the mode.
       */
      const switchingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
        const [id, mode] = arguments_
        if (mode === 'no key update' && id === invitee.id) await switchMode('full')
        return realLock.apply(this, arguments_)
      }

      let response: Response | undefined
      await withMutatedMethod(UserRepository.prototype, 'lockById', switchingLock, async () => {
        response = await postVerify(rawToken)
      })

      expect(response?.status).toBe(503)
      expect(response?.body).toMatchObject({ code: MAINTENANCE_MODE_CODE })
      expect(hasRefreshCookie(response)).toBe(false)
      expect(await refreshCount(invitee.id)).toBe(0)
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
      expect(await isPendingToken(rawToken)).toBe(true)
    }
  )

  it.each(['deleted', 'deactivated'] as const)(
    'answers invitation_invalid when the never-verified invitee is %s during the claim',
    async (change) => {
      const invitee = await createTrackedUser({ verified: false })
      const { tenant, rawToken } = await invitedTo(invitee.email)
      // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to call inside the mutated version, with its own `this`
      const realLock = UserRepository.prototype.lockById
      const changed = { done: false }
      /**
       * Stands in for `UserRepository.lockById`: just before the claim's first
       * lock, a delete or a deactivation commits on another connection.
       */
      const changingLock: typeof realLock = async function (this: UserRepository, ...arguments_) {
        const [id, mode] = arguments_
        if (mode === 'no key update' && id === invitee.id && !changed.done) {
          changed.done = true
          await (change === 'deleted'
            ? sql`update users set deleted_at = now() where id = ${invitee.id}`
            : sql`update users set active = false where id = ${invitee.id}`)
        }
        return realLock.apply(this, arguments_)
      }

      let response: Response | undefined
      await withMutatedMethod(UserRepository.prototype, 'lockById', changingLock, async () => {
        response = await postVerify(rawToken)
      })

      expect(response?.status).toBe(404)
      expect(response?.body).toMatchObject({ code: 'invitation_invalid' })
      expect(hasRefreshCookie(response)).toBe(false)
      expect(await refreshCount(invitee.id)).toBe(0)
      expect(
        await userMembershipRepository.findByUserAndTenant(invitee.id, tenant.id)
      ).toBeUndefined()
      expect(await isPendingToken(rawToken)).toBe(true)
    }
  )
})
