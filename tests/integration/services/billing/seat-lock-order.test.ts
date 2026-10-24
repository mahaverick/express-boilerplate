/**
 * @file The seat lock under concurrency: every write that adds a seat queues
 * on the workspace's billing row, so two of them at once never both take the
 * last seat, and an invite racing an accept settles without a deadlock.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vite-plus/test'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import { BillingRepository } from '@/repositories/billing.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { countSeats } from '@/services/billing/seats.service'
import { db, sql } from '@/services/database.service'
import {
  closeQueue,
  getAuthEmailQueue,
  getEmailQueue,
  getNotificationQueue,
} from '@/services/queue.service'
import { hashToken } from '@/services/session.service'
import { accept, invite } from '@/services/tenant-invitation.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { backendPid, deferred, waitForWaiter } from '../../../helpers/lock-probe'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'

const billingRepository = new BillingRepository()
const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const invitationRepository = new TenantInvitationRepository()

const DAY_MS = 24 * 60 * 60 * 1000
const tenantIds: string[] = []

afterEach(async () => {
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

afterAll(async () => {
  await getEmailQueue().obliterate({ force: true })
  await getAuthEmailQueue().obliterate({ force: true })
  await getNotificationQueue().obliterate({ force: true })
  await closeQueue()
})

/**
 * A Free workspace with its owner and `viewers` more members.
 * @param viewers - Members beyond the owner.
 * @returns The workspace and its owner.
 */
async function workspace(viewers = 0): Promise<{ tenant: Tenant; owner: User }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Race Co',
    slug: `seat-race-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  for (let index = 0; index < viewers; index += 1) {
    const member = await createTrackedUser()
    await membershipRepository.create({ userId: member.id, tenantId: tenant.id, role: 'viewer' })
  }
  return { tenant, owner }
}

/**
 * A pending viewer invitation for `email` with a known raw token.
 * @returns The raw token.
 */
async function pendingFor(tenant: Tenant, invitedBy: string, email: string): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url')
  await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId: tenant.id,
        email,
        role: 'viewer',
        tokenHash: hashToken(rawToken),
        invitedBy,
        expiresAt: new Date(Date.now() + DAY_MS),
      },
      tx
    )
  )
  return rawToken
}

/**
 * A fresh address.
 */
function address(): string {
  return `seat-race-${randomUUID()}@example.test`
}

/**
 * The HTTP status each settled call stands for: 202 for an invite that went
 * through, the refusal's status otherwise.
 */
function statusesOf(results: PromiseSettledResult<unknown>[]): number[] {
  return results.map((result) => {
    if (result.status === 'fulfilled') return 202
    return result.reason instanceof HttpError ? result.reason.statusCode : 500
  })
}

/**
 * Hold a workspace's billing row in an open transaction until released.
 * @returns The holder's backend pid, its release and the transaction's promise.
 */
async function holdSeatLock(
  tenantId: string
): Promise<{ pid: number; release: () => void; done: Promise<void> }> {
  const release = deferred()
  const holding = deferred<number>()
  const done = db.transaction(async (tx) => {
    await billingRepository.lockByTenantId(tenantId, tx)
    holding.resolve(await backendPid(tx))
    await release.promise
  })
  return { pid: await holding.promise, release: () => release.resolve(), done }
}

describe('the seat lock', () => {
  it('lets exactly one of two parallel invites at 2 of 3 through', async () => {
    const { tenant, owner } = await workspace(1)

    const results = await Promise.allSettled([
      invite({ userId: owner.id }, tenant.id, address(), 'viewer'),
      invite({ userId: owner.id }, tenant.id, address(), 'viewer'),
    ])

    expect(statusesOf(results).toSorted((a, b) => a - b)).toEqual([202, 402])
    expect(await countSeats(tenant.id, db)).toBe(3)
  })

  it('settles an accept and two invites at 2 of 3 with no deadlock and at most 3 seats', async () => {
    const { tenant, owner } = await workspace()
    const invitee = await createTrackedUser()
    const rawToken = await pendingFor(tenant, owner.id, invitee.email)

    const results = await Promise.allSettled([
      accept(rawToken, invitee.id),
      invite({ userId: owner.id }, tenant.id, address(), 'viewer'),
      invite({ userId: owner.id }, tenant.id, address(), 'viewer'),
    ])

    const [accepted, ...invites] = results
    expect(accepted.status).toBe('fulfilled')
    expect(statusesOf(invites).toSorted((a, b) => a - b)).toEqual([202, 402])
    expect(await membershipRepository.findByUserAndTenant(invitee.id, tenant.id)).toBeDefined()
    expect(await countSeats(tenant.id, db)).toBe(3)
  })

  it('makes an invite wait on the billing row', async () => {
    const { tenant, owner } = await workspace()
    const holder = await holdSeatLock(tenant.id)

    const inviting = invite({ userId: owner.id }, tenant.id, address(), 'viewer')

    expect(await waitForWaiter(holder.pid, inviting)).toBe(true)
    holder.release()
    await holder.done
    await expect(inviting).resolves.toBeUndefined()
  })

  it('makes an accept wait on the billing row', async () => {
    const { tenant, owner } = await workspace()
    const invitee = await createTrackedUser()
    const rawToken = await pendingFor(tenant, owner.id, invitee.email)
    const holder = await holdSeatLock(tenant.id)

    const accepting = accept(rawToken, invitee.id)

    expect(await waitForWaiter(holder.pid, accepting)).toBe(true)
    holder.release()
    await holder.done
    await expect(accepting).resolves.toMatchObject({ alreadyMember: false })
  })
})
