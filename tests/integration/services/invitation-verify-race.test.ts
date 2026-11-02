/**
 * @file Races on `POST /api/v1/invitations/verify`: a click that loses to a
 * concurrent confirm gets the generic `invitation_invalid` with no session,
 * and a maintenance mode that begins after the route's gate is refused with
 * the code sign-in verify answers, before anything is written. The races of
 * the confirm link itself are in invitation-confirm-race.test.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'supertest'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createApp } from '@/app'
import { getEnv } from '@/configs/env.config'
import { MAINTENANCE_MODE_CODE, READ_ONLY_MODE_CODE } from '@/constants/maintenance-mode.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { issueLinkToken } from '@/services/link-token.service'
import { reloadMaintenanceMode } from '@/services/maintenance-mode/maintenance-mode-store.service'
import { getRedis, redisKey } from '@/services/redis.service'
import { hashToken } from '@/services/session.service'
import { requireDurationMs } from '@/utilities/duration.utilities'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { resetMaintenanceMode, storeMaintenanceMode } from '../../helpers/maintenance-mode'
import { withMutatedMethod } from '../../helpers/mutate'
import { createTrackedUser, deleteTrackedUsers } from '../../helpers/platform-users'
import { testRefreshCookie } from '../../helpers/refresh-cookie'
import { request } from '../../helpers/request'

const app = createApp()
const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
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
 * @returns The tenant, the invitation's raw token and its id.
 */
async function invitedTo(
  email: string
): Promise<{ tenant: Tenant; rawToken: string; invitationId: string }> {
  const owner: User = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Acme Inc',
    slug: `invite-race-${randomUUID()}`,
    ownerId: owner.id,
  })
  createdTenantIds.push(tenant.id)
  const rawToken = randomBytes(32).toString('base64url')
  const invitation = await db.transaction((tx) =>
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
  return { tenant, rawToken, invitationId: invitation.id }
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
  it('answers invitation_invalid, not 202, when a concurrent confirm creates the account between the lookup and the account read', async () => {
    const email = `invite-race-late-${randomUUID()}@example.test`
    usedEmails.push(email)
    const { tenant, rawToken, invitationId } = await invitedTo(email)
    const { raw } = await issueLinkToken(
      { intent: 'invitation', email, app: 'web', invitationId },
      requireDurationMs(getEnv().SIGN_IN_LINK_TTL)
    )
    const realFind = UserRepository.prototype.findByEmail
    const winner: { started: boolean; response?: Response } = { started: false }
    /**
     * Stands in for `UserRepository.findByEmail`: on the losing click's
     * account read, the confirm runs to the end first. The confirm's own read
     * goes straight through.
     */
    const lateFind: typeof realFind = async function (this: UserRepository, ...arguments_) {
      if (!winner.started && arguments_[0] === email) {
        winner.started = true
        winner.response = await request(app)
          .post('/api/v1/invitations/confirm')
          .send({ token: raw, email })
      }
      return realFind.apply(this, arguments_)
    }

    let loser: Response | undefined
    await withMutatedMethod(UserRepository.prototype, 'findByEmail', lateFind, async () => {
      loser = await postVerify(rawToken)
    })

    expect(winner.response?.status).toBe(200)
    expect(loser?.status).toBe(404)
    expect(loser?.body).toMatchObject({ code: 'invitation_invalid' })
    expect(hasRefreshCookie(loser)).toBe(false)
    const memberships = await sql<{ count: number }[]>`
      select count(*)::int as count from user_memberships where tenant_id = ${tenant.id}
        and user_id in (select id from users where lower(email) = ${email})
    `
    expect(memberships[0]?.count).toBe(1)
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
})
