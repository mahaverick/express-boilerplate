/**
 * @file Exercises `platform.service` against the real per-worker Postgres.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { AuthProviderRepository } from '@/repositories/auth-provider.repository'
import { TenantInvitationRepository } from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { sql } from '@/services/database.service'
import { subscribeDomainEvent } from '@/services/domain-events.service'
import { bootstrapGrant, getPlatformMembership } from '@/services/platform.service'
import { hashToken, issueRefreshToken } from '@/services/session.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
const invitationRepository = new TenantInvitationRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()
const authProviderRepository = new AuthProviderRepository()

const STAFF_DOMAIN = 'staff.example.test'

/**
 * The user ids of every `email_verified` event emitted while this file runs, in order.
 */
const verifiedEvents: string[] = []
subscribeDomainEvent('email_verified', (event) => {
  verifiedEvents.push(event.userId)
})

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

    it('creates a verified user when platform:grant names an unknown address', async () => {
      const email = `Grant-New-${randomUUID()}@example.test`
      const platform = await platformTenant()
      const verifiedBefore = verifiedEvents.length

      const membership = await bootstrapGrant(email, 'owner')

      const [created] = await sql<
        { id: string; email: string; verified: boolean; hash: string | null }[]
      >`
        select id, email, email_verified_at is not null as verified, password_hash as hash
        from users where email = ${email.toLowerCase()} and deleted_at is null`
      expect(created).toBeDefined()
      createdUserIds.push(created?.id ?? '')
      // eslint-disable-next-line unicorn/no-null -- a created account has no password
      expect(created).toMatchObject({ email: email.toLowerCase(), verified: true, hash: null })
      expect(membership).toMatchObject({
        userId: created?.id,
        tenantId: platform.id,
        role: 'owner',
      })
      const providers =
        await sql`select provider from auth_providers where user_id = ${created?.id ?? ''}`
      expect(providers).toEqual([{ provider: 'email' }])
      expect(await auditRowsFor(created?.id ?? '')).toEqual([
        {
          action: 'user.created',
          actorKind: 'system',
          // eslint-disable-next-line unicorn/no-null -- the column is SQL NULL for a system actor
          actorUserId: null,
          access: 'system',
          tenantId: platform.id,
          targetType: 'user',
          targetId: created?.id,
          metadata: { emailDomain: 'example.test' },
        },
      ])
      const grantRows = await auditRowsFor(membership.id)
      expect(grantRows.map((row) => row.action)).toEqual(['platform.member.granted'])
      expect(verifiedEvents.slice(verifiedBefore)).toEqual([created?.id])
    })

    it('verifies and grants an existing unverified user', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: false })
      const verifiedBefore = verifiedEvents.length

      const membership = await bootstrapGrant(user.email, 'admin')

      expect(membership).toMatchObject({ userId: user.id, role: 'admin' })
      const [row] = await sql<{ verified: boolean }[]>`
        select email_verified_at is not null as verified from users where id = ${user.id}`
      expect(row?.verified).toBe(true)
      expect(verifiedEvents.slice(verifiedBefore)).toEqual([user.id])
      expect(await auditRowsFor(user.id)).toEqual([])
    })

    it("clears a squatter's password and Google link and revokes their sessions before granting", async () => {
      const user = await createUser(`grant-squat-${randomUUID()}@example.test`, {
        isVerified: false,
      })
      await sql`update users set password_hash = 'squatter-hash' where id = ${user.id}`
      await authProviderRepository.create({
        userId: user.id,
        provider: 'email',
        providerId: user.email,
      })
      await authProviderRepository.create({
        userId: user.id,
        provider: 'google',
        providerId: `squatter-google-${randomUUID()}`,
      })
      await issueRefreshToken(user.id, randomUUID())

      await bootstrapGrant(user.email, 'owner')

      const [row] = await sql<{ hash: string | null; verified: boolean }[]>`
        select password_hash as hash, email_verified_at is not null as verified
        from users where id = ${user.id}`
      // eslint-disable-next-line unicorn/no-null -- the squatter's password is gone
      expect(row).toEqual({ hash: null, verified: true })
      const providers = await sql`select provider from auth_providers where user_id = ${user.id}`
      expect(providers).toEqual([{ provider: 'email' }])
      const sessions = await sql<{ revoked: boolean }[]>`
        select revoked_at is not null as revoked from user_tokens
        where user_id = ${user.id} and purpose = 'refresh'`
      expect(sessions.length).toBeGreaterThan(0)
      expect(sessions.every((session) => session.revoked)).toBe(true)
      expect(await getPlatformMembership(user.id)).toBe('owner')
    })

    it('emits no email_verified for a user verified already', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: true })
      const verifiedBefore = verifiedEvents.length

      await bootstrapGrant(user.email, 'viewer')

      expect(verifiedEvents.slice(verifiedBefore)).toEqual([])
    })

    it('creates nothing when the grant fails', async () => {
      const email = `grant-fail-${randomUUID()}@example.test`

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'lockOwners',
        () => Promise.reject(new Error('grant failed')),
        async () => {
          await expect(bootstrapGrant(email, 'owner')).rejects.toThrow('grant failed')
        }
      )
      expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0)
    })

    it('refuses to demote the last platform owner', async () => {
      const user = await createUser(`grant-${randomUUID()}@example.test`, { isVerified: true })
      await grantPlatformRole(user.id, 'owner')

      // Other files may leave platform owners in this worker's database; pin the count.
      let ownerCounts = 0
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'countOwners',
        () => {
          ownerCounts += 1
          return Promise.resolve(1)
        },
        async () => {
          await expect(bootstrapGrant(user.email, 'viewer')).rejects.toMatchObject({
            statusCode: 409,
            message: 'Cannot demote the last platform owner',
          })
        }
      )
      // The refusal surfaces from the first attempt: only an address race is retried.
      expect(ownerCounts).toBe(1)
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
