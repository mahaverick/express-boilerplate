/**
 * @file Exercises `platform.service` against the real per-worker Postgres.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { bootstrapGrant, getPlatformMembership } from '@/services/platform.service'
import { hashToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const STAFF_DOMAIN = 'staff.example.test'

/**
 * One audit_logs row, as the assertions below read it.
 */
interface AuditRow {
  action: string
  actorKind: string
  actorUserId: string | null
  access: string
  tenantId: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
}

/**
 * Every audit row naming one target (a membership id here), oldest first.
 */
async function auditRowsFor(targetId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, actor_kind as "actorKind", actor_user_id as "actorUserId", access,
      tenant_id as "tenantId", target_type as "targetType", target_id as "targetId", metadata
    from audit_logs where target_id = ${targetId} order by occurred_at, id
  `
}

/**
 * The platform tenant that migration 0016 seeds; throws when it is missing.
 */
async function platformTenant(): Promise<Tenant> {
  const platform = await tenantRepository.findPlatformTenant()
  if (!platform) throw new Error('setup: migration 0016 seeds the platform tenant')
  return platform
}

/**
 * A unique address for one test.
 */
function staffEmail(): string {
  return `platform-service-${randomUUID()}@${STAFF_DOMAIN}`
}

/**
 * Give a user a platform role through the repository, so there is no audit row and
 * no last-owner check, unlike `bootstrapGrant`.
 */
async function grantPlatformRole(userId: string, role: MembershipRole): Promise<void> {
  const platform = await platformTenant()
  await userMembershipRepository.create({ userId, tenantId: platform.id, role })
}

describe('platform.service', () => {
  const createdUserIds: string[] = []

  afterEach(async () => {
    await truncateAuditLogs()
    vi.restoreAllMocks()
    if (createdUserIds.length === 0) return
    // Cascades to the users' platform memberships.
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * Create a user and track it for `afterEach` cleanup. `isVerified` sets
   * `email_verified_at` with raw SQL instead of `markEmailVerified`, and the
   * returned user is re-read so it carries that stamp.
   */
  async function createUser(email: string, options: { isVerified: boolean }): Promise<User> {
    const user = await userRepository.create({ email })
    createdUserIds.push(user.id)
    if (options.isVerified) {
      await sql`update users set email_verified_at = now() where id = ${user.id}`
    }
    const stored = await userRepository.findById(user.id)
    if (!stored) throw new Error('setup: user vanished')
    return stored
  }

  describe('getPlatformMembership', () => {
    it('returns the platform role for staff and null for everyone else', async () => {
      const staff = await createUser(staffEmail(), { isVerified: true })
      const outsider = await createUser(staffEmail(), { isVerified: true })
      await grantPlatformRole(staff.id, 'editor')

      expect(await getPlatformMembership(staff.id)).toBe('editor')
      expect(await getPlatformMembership(outsider.id)).toBeNull()
    })
  })

  describe('bootstrapGrant', () => {
    it('grants a verified user a platform role and audits it as a system grant', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: true })
      const platform = await platformTenant()

      const membership = await bootstrapGrant(user.email, 'owner')

      expect(membership).toMatchObject({ userId: user.id, tenantId: platform.id, role: 'owner' })
      expect(await auditRowsFor(membership.id)).toEqual([
        {
          action: 'platform.member.granted',
          actorKind: 'system',
          // eslint-disable-next-line unicorn/no-null -- the column is SQL NULL for a system actor
          actorUserId: null,
          access: 'system',
          tenantId: platform.id,
          targetType: 'membership',
          targetId: membership.id,
          metadata: { userId: user.id, role: 'owner', via: 'script' },
        },
      ])
    })

    it('changes the role of an existing platform membership', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: true })
      await grantPlatformRole(user.id, 'viewer')

      const membership = await bootstrapGrant(user.email, 'admin')

      expect(membership.role).toBe('admin')
      expect(await getPlatformMembership(user.id)).toBe('admin')
    })

    it('refuses an address with no account', async () => {
      await expect(
        bootstrapGrant(`nobody-${randomUUID()}@example.test`, 'owner')
      ).rejects.toMatchObject({
        statusCode: 404,
      })
    })

    it('refuses an unverified account, and grants nothing', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: false })

      await expect(bootstrapGrant(user.email, 'owner')).rejects.toMatchObject({ statusCode: 409 })
      expect(await getPlatformMembership(user.id)).toBeNull()
    })

    it('refuses to demote the last platform owner', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: true })
      await grantPlatformRole(user.id, 'owner')

      // Other files may leave platform owners in this worker's database; pin the count.
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'countOwners',
        () => Promise.resolve(1),
        async () => {
          await expect(bootstrapGrant(user.email, 'viewer')).rejects.toMatchObject({
            statusCode: 409,
          })
        }
      )
      expect(await getPlatformMembership(user.id)).toBe('owner')
    })

    it('revokes on a script demotion the invitations the new role cannot grant, here and in customer tenants', async () => {
      const staff = await createUser(staffEmail(), { isVerified: true })
      const customerOwner = await createUser(`grant-${randomUUID()}@example.test`, {
        isVerified: true,
      })
      await grantPlatformRole(staff.id, 'admin')
      const platform = await platformTenant()
      const customer = await tenantRepository.create({
        name: 'Acme Inc',
        slug: `tenant-${randomUUID()}`,
        ownerId: customerOwner.id,
      })
      /**
       * A pending invitation from `staff` to a random address, valid for an hour.
       */
      const invite = (tenantId: string, role: MembershipRole) =>
        invitationRepository.createPending({
          tenantId,
          email: `platform-service-invitee-${randomUUID()}@example.test`,
          role,
          tokenHash: hashToken(randomUUID()),
          invitedBy: staff.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
      const platformOffer = await invite(platform.id, 'admin')
      const customerOffer = await invite(customer.id, 'admin')
      try {
        await bootstrapGrant(staff.email, 'viewer')

        const rows = await sql<{ id: string; revoked: boolean }[]>`
          select id, revoked_at is not null as revoked from tenant_invitations
          where id = any(${[platformOffer.id, customerOffer.id]})`
        expect(rows.every((row) => row.revoked)).toBe(true)
        expect(rows).toHaveLength(2)
        const entries = await sql<{ targetId: string; actorKind: string; access: string }[]>`
          select target_id as "targetId", actor_kind as "actorKind", access from audit_logs
          where action = 'invitation.revoked' and target_id = any(${[platformOffer.id, customerOffer.id]})
          order by target_id`
        expect(entries).toEqual(
          [platformOffer.id, customerOffer.id]
            .toSorted((a, b) => a.localeCompare(b))
            .map((targetId) => ({ targetId, actorKind: 'system', access: 'system' }))
        )
      } finally {
        await sql`delete from tenant_invitations where id = ${platformOffer.id}`
        // The revoke's audit rows reference the tenant.
        await truncateAuditLogs()
        await sql`delete from tenants where id = ${customer.id}`
      }
    })
  })
})
