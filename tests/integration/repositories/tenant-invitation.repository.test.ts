// tests/integration/repositories/tenant-invitation.repository.test.ts
//
// Against the real per-worker Postgres database. afterEach deletes tenants
// first (tenant_invitations.tenant_id cascades), then users
// (invited_by/accepted_by are SET NULL).
import { randomBytes, randomUUID } from 'node:crypto'
import { DrizzleQueryError, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  tenantInvitationModel,
  type TenantInvitation,
} from '@/database/models/tenant-invitation.model'
import type { Tenant } from '@/database/models/tenant.model'
import type { User } from '@/database/models/user.model'
import { HttpError } from '@/errors/http-error'
import {
  TenantInvitationRepository,
  type NewPendingInvitation,
} from '@/repositories/tenant-invitation.repository'
import { TenantRepository } from '@/repositories/tenant.repository'
import { UserRepository } from '@/repositories/user.repository'
import { db, sql } from '@/services/database.service'

const invitationRepository = new TenantInvitationRepository()
const tenantRepository = new TenantRepository()
const userRepository = new UserRepository()

// The test pool's own size (database.service.ts, `max: 2`), so both claims
// really run at the database at once.
const CONCURRENT_CLAIMS = 2
const HOUR_MS = 60 * 60 * 1000

/**
 * A disposable email, unique to one call.
 * @returns An email guaranteed unique to this call.
 */
function uniqueEmail(): string {
  return `invitation-repo-${randomUUID()}@example.test`
}

/**
 * A disposable 64-character hex string standing in for a token hash.
 * @returns A hash unique to this call.
 */
function uniqueHash(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The current state of one invitation row, read straight from the table.
 * @param id - The invitation id.
 * @returns The row, or undefined when it does not exist.
 */
async function reload(id: string): Promise<TenantInvitation | undefined> {
  const [row] = await db
    .select()
    .from(tenantInvitationModel)
    .where(eq(tenantInvitationModel.id, id))
  return row
}

/**
 * Create a pending invitation inside a transaction, as the service does.
 * @param overrides - The tenant and inviter, plus any field to override.
 * @returns The inserted row.
 */
async function createPending(
  overrides: Partial<NewPendingInvitation> & Pick<NewPendingInvitation, 'tenantId' | 'invitedBy'>
): Promise<TenantInvitation> {
  return db.transaction((tx) =>
    invitationRepository.createPending(
      {
        email: uniqueEmail(),
        role: 'viewer',
        tokenHash: uniqueHash(),
        expiresAt: new Date(Date.now() + HOUR_MS),
        ...overrides,
      },
      tx
    )
  )
}

describe('TenantInvitationRepository', () => {
  const createdTenantIds: string[] = []
  const createdUserIds: string[] = []

  afterEach(async () => {
    if (createdTenantIds.length > 0) {
      await sql`delete from tenants where id = any(${createdTenantIds})`
      createdTenantIds.length = 0
    }
    if (createdUserIds.length === 0) return
    await sql`delete from users where id = any(${createdUserIds})`
    createdUserIds.length = 0
  })

  /**
   * A fresh user named Ada Lovelace, tracked for cleanup.
   * @returns The created user.
   */
  async function createUser(): Promise<User> {
    const user = await userRepository.create({
      email: uniqueEmail(),
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    createdUserIds.push(user.id)
    return user
  }

  /**
   * An owner and a tenant they own, both tracked for cleanup.
   * @returns The owner and the tenant.
   */
  async function setup(): Promise<{ owner: User; tenant: Tenant }> {
    const owner = await createUser()
    const tenant = await tenantRepository.create({
      name: 'Acme Inc',
      slug: `tenant-${randomUUID()}`,
      ownerId: owner.id,
    })
    createdTenantIds.push(tenant.id)
    return { owner, tenant }
  }

  describe('createPending', () => {
    it('inserts a pending row', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()

      const row = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        email,
        role: 'editor',
      })

      expect(row).toMatchObject({
        tenantId: tenant.id,
        email,
        role: 'editor',
        invitedBy: owner.id,
      })
      expect(row.acceptedAt).toBeNull()
      expect(row.acceptedBy).toBeNull()
      expect(row.revokedAt).toBeNull()
    })

    it('revokes the pending invitation for the same tenant and address, whatever its case', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      const first = await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })

      const second = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        email: email.toUpperCase(),
      })

      const reloadedFirst = await reload(first.id)
      expect(reloadedFirst?.revokedAt).toBeInstanceOf(Date)
      expect(second.revokedAt).toBeNull()
      const pending = await invitationRepository.listPending(tenant.id)
      expect(pending.map((invitation) => invitation.id)).toEqual([second.id])
    })

    // An expired row still holds the partial index's slot (it cannot filter
    // on now()); without the revoke this insert would 23505.
    it('replaces an expired pending invitation too', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      const expired = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        email,
        expiresAt: new Date(Date.now() - HOUR_MS),
      })

      const fresh = await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })

      const reloadedExpired = await reload(expired.id)
      expect(reloadedExpired?.revokedAt).toBeInstanceOf(Date)
      expect(fresh.revokedAt).toBeNull()
    })

    it('leaves the same address pending in another tenant alone', async () => {
      const { owner, tenant } = await setup()
      const { tenant: otherTenant } = await setup()
      const email = uniqueEmail()
      const elsewhere = await createPending({
        tenantId: otherTenant.id,
        invitedBy: owner.id,
        email,
      })

      await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })

      const reloadedElsewhere = await reload(elsewhere.id)
      expect(reloadedElsewhere?.revokedAt).toBeNull()
    })

    it('has the database refuse a second pending row for one tenant and address', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()
      await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })

      await expect(
        sql`insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
            values (${tenant.id}, ${email.toUpperCase()}, 'viewer', ${uniqueHash()}, now() + interval '1 hour')`
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'tenant_invitations_pending_unique',
      })
    })

    it('has the database refuse a duplicate token hash', async () => {
      const { owner, tenant } = await setup()
      const existing = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      await expect(
        sql`insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
            values (${tenant.id}, ${uniqueEmail()}, 'viewer', ${existing.tokenHash}, now() + interval '1 hour')`
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'tenant_invitations_token_hash_unique',
      })
    })

    it('rethrows a unique violation other than the pending slot, not as invitation_conflict', async () => {
      const { owner, tenant } = await setup()
      const existing = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      let error: unknown
      try {
        await createPending({
          tenantId: tenant.id,
          invitedBy: owner.id,
          tokenHash: existing.tokenHash,
        })
      } catch (error_) {
        error = error_
      }

      expect(error).toBeInstanceOf(DrizzleQueryError)
      expect(error).not.toBeInstanceOf(HttpError)
      expect((error as DrizzleQueryError).cause).toMatchObject({
        code: '23505',
        constraint_name: 'tenant_invitations_token_hash_unique',
      })
    })

    it('leaves an accepted invitation for the same address untouched', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const email = uniqueEmail()
      const accepted = await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })
      await invitationRepository.claimForAccept(accepted.tokenHash, invitee.id)

      await createPending({ tenantId: tenant.id, invitedBy: owner.id, email })

      const reloaded = await reload(accepted.id)
      expect(reloaded?.revokedAt).toBeNull()
      expect(reloaded?.acceptedBy).toBe(invitee.id)
    })

    it('has the database refuse an unknown role', async () => {
      const { tenant } = await setup()

      await expect(
        sql`insert into tenant_invitations (tenant_id, email, role, token_hash, expires_at)
            values (${tenant.id}, ${uniqueEmail()}, 'superuser', ${uniqueHash()}, now() + interval '1 hour')`
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('never leaves two pending rows when two invites of one address race', async () => {
      const { owner, tenant } = await setup()
      const email = uniqueEmail()

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT_CLAIMS }, () =>
          createPending({ tenantId: tenant.id, invitedBy: owner.id, email })
        )
      )

      for (const result of results) {
        if (result.status !== 'rejected') continue
        expect(result.reason).toBeInstanceOf(HttpError)
        expect(result.reason).toMatchObject({ statusCode: 409, code: 'invitation_conflict' })
      }
      const pending = await invitationRepository.listPending(tenant.id)
      expect(pending).toHaveLength(1)
    })
  })

  describe('listPending', () => {
    it('lists pending, unexpired invitations newest first, with the inviter name and no token hash', async () => {
      const { owner, tenant } = await setup()
      const older = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      const newer = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        role: 'editor',
      })
      await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() - HOUR_MS),
      })
      const revoked = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.revoke(tenant.id, revoked.id)
      const accepted = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.claimForAccept(accepted.tokenHash, owner.id)

      const pending = await invitationRepository.listPending(tenant.id)

      expect(pending.map((invitation) => invitation.id)).toEqual([newer.id, older.id])
      expect(pending[0]).toStrictEqual({
        id: newer.id,
        email: newer.email,
        role: 'editor',
        invitedBy: { id: owner.id, firstName: 'Ada', lastName: 'Lovelace' },
        expiresAt: newer.expiresAt,
        createdAt: newer.createdAt,
      })
    })

    it('reports invitedBy as null once the inviter is deleted', async () => {
      const { tenant } = await setup()
      const inviter = await createUser()
      await createPending({ tenantId: tenant.id, invitedBy: inviter.id })

      await sql`delete from users where id = ${inviter.id}`

      const [pending] = await invitationRepository.listPending(tenant.id)
      expect(pending).toBeDefined()
      expect(pending?.invitedBy).toBeNull()
    })

    it('reports invitedBy as null once the inviter is soft-deleted', async () => {
      const { tenant } = await setup()
      const inviter = await createUser()
      await createPending({ tenantId: tenant.id, invitedBy: inviter.id })

      await userRepository.softDelete(inviter.id)

      const [pending] = await invitationRepository.listPending(tenant.id)
      expect(pending).toBeDefined()
      expect(pending?.invitedBy).toBeNull()
    })
  })

  describe('findPendingById', () => {
    it('finds a pending invitation only within its own tenant, and not once revoked', async () => {
      const { owner, tenant } = await setup()
      const { tenant: otherTenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      const found = await invitationRepository.findPendingById(tenant.id, invitation.id)
      expect(found?.id).toBe(invitation.id)
      expect(
        await invitationRepository.findPendingById(otherTenant.id, invitation.id)
      ).toBeUndefined()

      await invitationRepository.revoke(tenant.id, invitation.id)
      expect(await invitationRepository.findPendingById(tenant.id, invitation.id)).toBeUndefined()
    })
  })

  describe('findValidByTokenHash', () => {
    it('returns a valid invitation with its tenant and inviter', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      const found = await invitationRepository.findValidByTokenHash(invitation.tokenHash)

      expect(found?.invitation.id).toBe(invitation.id)
      expect(found?.tenant).toStrictEqual({ id: tenant.id, name: 'Acme Inc', slug: tenant.slug })
      expect(found?.invitedBy).toStrictEqual({ firstName: 'Ada', lastName: 'Lovelace' })
    })

    it('rejects an expired invitation', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() - 1000),
      })

      expect(await invitationRepository.findValidByTokenHash(invitation.tokenHash)).toBeUndefined()
    })

    it('rejects a revoked invitation', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.revoke(tenant.id, invitation.id)

      expect(await invitationRepository.findValidByTokenHash(invitation.tokenHash)).toBeUndefined()
    })

    it('rejects an accepted invitation', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.claimForAccept(invitation.tokenHash, owner.id)

      expect(await invitationRepository.findValidByTokenHash(invitation.tokenHash)).toBeUndefined()
    })

    it('rejects an invitation to a soft-deleted tenant', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await tenantRepository.softDelete(tenant.id)

      expect(await invitationRepository.findValidByTokenHash(invitation.tokenHash)).toBeUndefined()
    })

    it('reports invitedBy as null once the inviter is soft-deleted', async () => {
      const { tenant } = await setup()
      const inviter = await createUser()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: inviter.id })

      await userRepository.softDelete(inviter.id)

      const found = await invitationRepository.findValidByTokenHash(invitation.tokenHash)
      expect(found?.invitation.id).toBe(invitation.id)
      expect(found?.invitedBy).toBeNull()
    })
  })

  describe('findByTokenHash', () => {
    it('returns an invitation in any state, with its tenant', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.claimForAccept(invitation.tokenHash, owner.id)

      const found = await invitationRepository.findByTokenHash(invitation.tokenHash)

      expect(found?.invitation.acceptedBy).toBe(owner.id)
      expect(found?.tenant).toStrictEqual({ id: tenant.id, name: 'Acme Inc', slug: tenant.slug })
    })

    it('excludes an invitation to a soft-deleted tenant, and an unknown hash', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await tenantRepository.softDelete(tenant.id)

      expect(await invitationRepository.findByTokenHash(invitation.tokenHash)).toBeUndefined()
      expect(await invitationRepository.findByTokenHash(uniqueHash())).toBeUndefined()
    })
  })

  describe('claimForAccept', () => {
    it('claims once; a second claim gets nothing', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      const first = await invitationRepository.claimForAccept(invitation.tokenHash, invitee.id)
      const second = await invitationRepository.claimForAccept(invitation.tokenHash, invitee.id)

      expect(first?.acceptedBy).toBe(invitee.id)
      expect(first?.acceptedAt).toBeInstanceOf(Date)
      expect(second).toBeUndefined()
    })

    it('refuses an expired or a revoked invitation', async () => {
      const { owner, tenant } = await setup()
      const expired = await createPending({
        tenantId: tenant.id,
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() - 1000),
      })
      const revoked = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.revoke(tenant.id, revoked.id)

      expect(await invitationRepository.claimForAccept(expired.tokenHash, owner.id)).toBeUndefined()
      expect(await invitationRepository.claimForAccept(revoked.tokenHash, owner.id)).toBeUndefined()
    })

    it('refuses an invitation to a soft-deleted tenant, and claims nothing', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await tenantRepository.softDelete(tenant.id)

      expect(
        await invitationRepository.claimForAccept(invitation.tokenHash, invitee.id)
      ).toBeUndefined()
      const reloaded = await reload(invitation.id)
      expect(reloaded?.acceptedAt).toBeNull()
    })

    it('keeps the claim, with acceptedBy null, once the accepting user is deleted', async () => {
      const { owner, tenant } = await setup()
      const invitee = await createUser()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.claimForAccept(invitation.tokenHash, invitee.id)

      await sql`delete from users where id = ${invitee.id}`

      const reloaded = await reload(invitation.id)
      expect(reloaded?.acceptedBy).toBeNull()
      expect(reloaded?.acceptedAt).toBeInstanceOf(Date)
    })

    it('lets exactly one of two concurrent claims win', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      const claimants = await Promise.all(
        Array.from({ length: CONCURRENT_CLAIMS }, () => createUser())
      )

      const results = await Promise.all(
        claimants.map((claimant) =>
          invitationRepository.claimForAccept(invitation.tokenHash, claimant.id)
        )
      )

      const winners = results.filter((result) => result !== undefined)
      expect(winners).toHaveLength(1)
      const reloaded = await reload(invitation.id)
      expect(reloaded?.acceptedBy).toBe(winners[0]?.acceptedBy)
    })
  })

  describe('replaceToken', () => {
    it('swaps the hash and expiry of a pending invitation, so the old hash stops resolving', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      const newHash = uniqueHash()
      const newExpiry = new Date(Date.now() + 2 * HOUR_MS)

      const updated = await invitationRepository.replaceToken(invitation.id, newHash, newExpiry)

      expect(updated).toMatchObject({ id: invitation.id, tokenHash: newHash, expiresAt: newExpiry })
      expect(await invitationRepository.findValidByTokenHash(invitation.tokenHash)).toBeUndefined()
      const resolved = await invitationRepository.findValidByTokenHash(newHash)
      expect(resolved?.invitation.id).toBe(invitation.id)
    })

    it('leaves a revoked invitation alone', async () => {
      const { owner, tenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })
      await invitationRepository.revoke(tenant.id, invitation.id)

      expect(
        await invitationRepository.replaceToken(invitation.id, uniqueHash(), new Date())
      ).toBeUndefined()
    })
  })

  describe('revoke', () => {
    it('revokes a pending invitation once, and only within its own tenant', async () => {
      const { owner, tenant } = await setup()
      const { tenant: otherTenant } = await setup()
      const invitation = await createPending({ tenantId: tenant.id, invitedBy: owner.id })

      expect(await invitationRepository.revoke(otherTenant.id, invitation.id)).toBe(false)
      expect(await invitationRepository.revoke(tenant.id, invitation.id)).toBe(true)
      expect(await invitationRepository.revoke(tenant.id, invitation.id)).toBe(false)
    })
  })
})
