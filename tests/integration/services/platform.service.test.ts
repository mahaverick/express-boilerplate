// tests/integration/services/platform.service.test.ts
//
// platform.service against the real per-worker Postgres. The domain list is
// passed in: the suite's environment leaves PLATFORM_EMAIL_DOMAINS unset,
// which is itself the "nobody joins" case.
import { randomUUID } from 'node:crypto'
import { sql as drizzleSql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MembershipRole } from '@/constants/tenant.constants'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserMembershipRepository } from '@/repositories/user-membership.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'
import { logger } from '@/services/logger.service'
import {
  autoJoin,
  autoJoinSafely,
  bootstrapGrant,
  getPlatformMembership,
} from '@/services/platform.service'
import { truncateAuditLogs } from '../../helpers/audit-log'
import { withMutatedMethod } from '../../helpers/mutate'

const tenantRepository = new TenantRepository()
const userMembershipRepository = new UserMembershipRepository()
const userRepository = new UserRepository()

const STAFF_DOMAIN = 'staff.example.test'
const DOMAINS = [STAFF_DOMAIN]

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
 * Every audit row that names one target.
 * @param targetId - The membership (or other target) id.
 * @returns The rows, oldest first.
 */
async function auditRowsFor(targetId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, actor_kind as "actorKind", actor_user_id as "actorUserId", access,
      tenant_id as "tenantId", target_type as "targetType", target_id as "targetId", metadata
    from audit_logs where target_id = ${targetId} order by occurred_at, id
  `
}

/**
 * The seeded platform tenant.
 * @returns Its row.
 */
async function platformTenant(): Promise<Tenant> {
  const platform = await tenantRepository.findPlatformTenant()
  if (!platform) throw new Error('setup: migration 0016 seeds the platform tenant')
  return platform
}

/**
 * A fresh address on the staff domain.
 * @returns The address.
 */
function staffEmail(): string {
  return `platform-service-${randomUUID()}@${STAFF_DOMAIN}`
}

/**
 * Give a user a platform role directly.
 * @param userId - The user.
 * @param role - The platform role.
 */
async function grantPlatformRole(userId: string, role: MembershipRole): Promise<void> {
  const platform = await platformTenant()
  await userMembershipRepository.create({ userId, tenantId: platform.id, role })
}

/**
 * An insertIfAbsent stand-in that raises a real SQL error, so Postgres
 * aborts whatever transaction ran it.
 * @param _data - Ignored.
 * @param executor - Where the failing statement runs.
 * @returns Never resolves with a row.
 */
const failingInsert: UserMembershipRepository['insertIfAbsent'] = async (_data, executor = db) => {
  await executor.execute(drizzleSql`select 1 / 0`)
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
   * A fresh user, tracked for cleanup.
   * @param email - The address.
   * @param options - Setup choices.
   * @param options.isVerified - Whether to mark the address verified (raw SQL, not markEmailVerified).
   * @returns The user as stored.
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

  describe('autoJoin', () => {
    it('joins a verified address on a listed domain as viewer, and audits it once as a system action', async () => {
      const user = await createUser(staffEmail(), { isVerified: true })
      const platform = await platformTenant()

      const joined = await db.transaction((tx) => autoJoin(user, tx, DOMAINS))

      expect(joined?.role).toBe('viewer')
      expect(joined?.tenantId).toBe(platform.id)
      if (!joined) throw new Error('unreachable: asserted above')
      expect(await auditRowsFor(joined.id)).toEqual([
        {
          action: 'platform.member.auto_joined',
          actorKind: 'system',
          // eslint-disable-next-line unicorn/no-null -- the column is SQL NULL for a system actor
          actorUserId: null,
          access: 'system',
          tenantId: platform.id,
          targetType: 'membership',
          targetId: joined.id,
          metadata: { userId: user.id, emailDomain: STAFF_DOMAIN },
        },
      ])
    })

    it('does not join a subdomain of a listed domain', async () => {
      const user = await createUser(`platform-service-${randomUUID()}@eu.${STAFF_DOMAIN}`, {
        isVerified: true,
      })

      expect(await db.transaction((tx) => autoJoin(user, tx, DOMAINS))).toBeUndefined()
      expect(await getPlatformMembership(user.id)).toBeNull()
    })

    it('does not join an unverified address', async () => {
      const user = await createUser(staffEmail(), { isVerified: false })

      expect(await db.transaction((tx) => autoJoin(user, tx, DOMAINS))).toBeUndefined()
      expect(await getPlatformMembership(user.id)).toBeNull()
    })

    it('leaves an existing platform membership alone: no demotion, no second audit row', async () => {
      const user = await createUser(staffEmail(), { isVerified: true })
      await grantPlatformRole(user.id, 'admin')

      expect(await db.transaction((tx) => autoJoin(user, tx, DOMAINS))).toBeUndefined()

      expect(await getPlatformMembership(user.id)).toBe('admin')
      const rows = await sql`
        select id from audit_logs
        where action = 'platform.member.auto_joined' and metadata->>'userId' = ${user.id}
      `
      expect(rows).toHaveLength(0)
    })
  })

  describe('autoJoinSafely', () => {
    it('joins nobody when PLATFORM_EMAIL_DOMAINS is unset (the suite default)', async () => {
      const user = await createUser(staffEmail(), { isVerified: true })

      await autoJoinSafely(user)

      expect(await getPlatformMembership(user.id)).toBeNull()
    })

    it('logs a failure at warn instead of throwing it', async () => {
      const user = await createUser(staffEmail(), { isVerified: true })
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'insertIfAbsent',
        () => Promise.reject(new Error('insert failed')),
        async () => {
          await expect(autoJoinSafely(user, db, DOMAINS)).resolves.toBeUndefined()
        }
      )

      expect(warn).toHaveBeenCalledWith(
        'Platform auto-join failed',
        expect.objectContaining({ userId: user.id })
      )
      expect(await getPlatformMembership(user.id)).toBeNull()
    })

    it('rolls back only its own savepoint when it fails inside a caller transaction', async () => {
      const user = await createUser(staffEmail(), { isVerified: true })
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      await withMutatedMethod(
        UserMembershipRepository.prototype,
        'insertIfAbsent',
        failingInsert,
        async () => {
          await db.transaction(async (tx) => {
            await autoJoinSafely(user, tx, DOMAINS)
            // Fails with "current transaction is aborted" unless the join ran in a savepoint.
            await userRepository.update(user.id, { firstName: 'Still usable' }, {}, tx)
          })
        }
      )

      const updated = await userRepository.findById(user.id)
      expect(updated?.firstName).toBe('Still usable')
      expect(await getPlatformMembership(user.id)).toBeNull()
    })
  })

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
  })
})
