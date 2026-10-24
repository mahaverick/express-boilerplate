/**
 * @file A workspace's effective entitlements and its seat count, against the
 * real per-worker database: the plan its state maps to, grants on top, and
 * who holds a seat.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { getEffectiveEntitlements } from '@/services/billing/entitlements.service'
import { countSeats } from '@/services/billing/seats.service'
import { db, sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../../helpers/audit-log'
import { grantSeats, putTenantOnPaid } from '../../../helpers/billing'
import { platformTenant } from '../../../helpers/platform-staff'
import { createTrackedUser, deleteTrackedUsers } from '../../../helpers/platform-users'

const tenantRepository = new TenantRepository()
const membershipRepository = new UserMembershipRepository()
const invitationRepository = new TenantInvitationRepository()

const DAY_MS = 24 * 60 * 60 * 1000
const tenantIds: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAuditLogs()
  if (tenantIds.length > 0) await sql`delete from tenants where id = any(${tenantIds})`
  tenantIds.length = 0
  await deleteTrackedUsers()
})

/**
 * A Free workspace with its owner and `members` more viewers.
 * @param members - Viewers beyond the owner.
 * @returns The workspace id and the owner's id.
 */
async function freeWorkspace(members = 0): Promise<{ tenantId: string; ownerId: string }> {
  const owner = await createTrackedUser()
  const tenant = await tenantRepository.create({
    name: 'Seats Co',
    slug: `ent-${randomUUID()}`,
    ownerId: owner.id,
  })
  tenantIds.push(tenant.id)
  for (let index = 0; index < members; index += 1) {
    const member = await createTrackedUser()
    await membershipRepository.create({ userId: member.id, tenantId: tenant.id, role: 'viewer' })
  }
  return { tenantId: tenant.id, ownerId: owner.id }
}

/**
 * Write a pending invitation directly.
 * @param tenantId - The workspace.
 * @param invitedBy - The inviter.
 * @param expiresAt - When it lapses.
 * @param email - The address; a fresh one when omitted.
 */
async function pendingInvitation(
  tenantId: string,
  invitedBy: string,
  expiresAt: Date,
  email = `ent-${randomUUID()}@example.test`
): Promise<void> {
  await db.transaction((tx) =>
    invitationRepository.createPending(
      {
        tenantId,
        email,
        role: 'viewer',
        tokenHash: hashToken(randomBytes(32).toString('base64url')),
        invitedBy,
        expiresAt,
      },
      tx
    )
  )
}

describe('getEffectiveEntitlements', () => {
  it('gives a Free workspace three seats and no insights', async () => {
    const { tenantId } = await freeWorkspace(1)

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements).toMatchObject({
      plan: { key: 'free', name: 'Free' },
      state: 'free',
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      pastDue: null,
      features: { advanced_example: false },
      limits: { members: { limit: 3, used: 2, approaching: false } },
      sources: { members: 'plan', advanced_example: 'plan' },
    })
  })

  it('counts a pending invitation in the members used', async () => {
    const { tenantId, ownerId } = await freeWorkspace(1)
    await pendingInvitation(tenantId, ownerId, new Date(Date.now() + DAY_MS))

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements.limits.members).toEqual({ limit: 3, used: 3, approaching: false })
  })

  it('serves a trialing workspace the Paid values', async () => {
    const { tenantId } = await freeWorkspace()
    const trialEndsAt = new Date(Date.now() + 5 * DAY_MS)
    await sql`update tenant_billing set state = 'trialing', trial_ends_at = ${trialEndsAt.toISOString()}::timestamptz where tenant_id = ${tenantId}`

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements).toMatchObject({
      plan: { key: 'paid', name: 'Paid' },
      state: 'trialing',
      features: { advanced_example: true },
      limits: { members: { limit: null, used: 1, approaching: false } },
    })
    expect(entitlements.trialEndsAt?.toISOString()).toBe(trialEndsAt.toISOString())
  })

  it('reads a trial that ended as Free before any job runs', async () => {
    const { tenantId } = await freeWorkspace()
    await sql`update tenant_billing set state = 'trialing', trial_ends_at = now() - interval '1 hour' where tenant_id = ${tenantId}`

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements).toMatchObject({
      plan: { key: 'free' },
      state: 'free',
      limits: { members: { limit: 3 } },
    })
  })

  it('raises the members limit to a grant of 10, sourced from the grant', async () => {
    const { tenantId } = await freeWorkspace()
    await grantSeats(tenantId, 10)

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements.limits.members).toMatchObject({ limit: 10, used: 1 })
    expect(entitlements.sources.members).toBe('grant')
    expect(entitlements.sources.advanced_example).toBe('plan')
  })

  it('reports a past-due workspace with its grace window', async () => {
    const { tenantId } = await freeWorkspace()
    await putTenantOnPaid(tenantId)
    const since = new Date(Date.now() - DAY_MS)
    await sql`update tenant_billing set state = 'past_due', past_due_since = ${since.toISOString()}::timestamptz, halted_at = ${since.toISOString()}::timestamptz where tenant_id = ${tenantId}`
    const [settings] = await sql<
      { days: number }[]
    >`select past_due_grace_days as days from billing_settings`

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements.state).toBe('past_due')
    expect(entitlements.pastDue).toEqual({
      since,
      graceEndsAt: new Date(since.getTime() + (settings?.days ?? 0) * DAY_MS),
      paused: false,
    })
  })

  it('gives the platform tenant every feature and no limit', async () => {
    const platform = await platformTenant()

    const entitlements = await getEffectiveEntitlements(platform.id)

    expect(entitlements.features).toEqual({ advanced_example: true })
    expect(entitlements.limits.members?.limit).toBeNull()
  })

  it('treats a customer workspace with no billing row as Free and logs it', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { tenantId } = await freeWorkspace()
    await sql`delete from tenant_billing where tenant_id = ${tenantId}`

    const entitlements = await getEffectiveEntitlements(tenantId)

    expect(entitlements).toMatchObject({
      plan: { key: 'free' },
      state: 'free',
      features: { advanced_example: false },
      limits: { members: { limit: 3 } },
    })
    expect(error).toHaveBeenCalledWith(expect.any(String), { tenantId })
  })
})

describe('countSeats', () => {
  it('counts members and pending, unexpired invitations', async () => {
    const { tenantId, ownerId } = await freeWorkspace(1)
    await pendingInvitation(tenantId, ownerId, new Date(Date.now() + DAY_MS))

    expect(await countSeats(tenantId, db)).toBe(3)
  })

  it('leaves out an expired invitation', async () => {
    const { tenantId, ownerId } = await freeWorkspace(1)
    await pendingInvitation(tenantId, ownerId, new Date(Date.now() - DAY_MS))

    expect(await countSeats(tenantId, db)).toBe(2)
  })

  it('leaves out a soft-deleted member', async () => {
    const { tenantId } = await freeWorkspace(2)
    const [member] = await sql<{ user_id: string }[]>`
      select user_id from user_memberships where tenant_id = ${tenantId} and role = 'viewer' limit 1`
    await sql`update users set deleted_at = now() where id = ${member?.user_id ?? ''}`

    expect(await countSeats(tenantId, db)).toBe(2)
  })

  it('counts an address once when it is both a member and invited', async () => {
    const { tenantId, ownerId } = await freeWorkspace()
    const member = await createTrackedUser()
    await membershipRepository.create({ userId: member.id, tenantId, role: 'viewer' })
    await pendingInvitation(tenantId, ownerId, new Date(Date.now() + DAY_MS), member.email)

    expect(await countSeats(tenantId, db)).toBe(2)
  })
})
