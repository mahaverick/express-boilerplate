// src/repositories/tenant-invitation.repository.ts
//
// Query access to `tenant_invitations`. Standalone (no BaseRepository): the
// table has no `deletedAt`. Every method takes an optional executor so the
// invitation service can compose calls in one transaction. Lookups by token
// join `tenants` and exclude a soft-deleted tenant.
import { and, desc, DrizzleQueryError, eq, gt, isNull, sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { MembershipRole } from '@/constants/tenant.constants'
import {
  tenantInvitationModel,
  type TenantInvitation,
} from '@/database/models/tenant-invitation.model'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db, type DbExecutor } from '@/services/database.service'

// Postgres unique_violation, as in base.repository.ts.
const UNIQUE_VIOLATION_CODE = '23505'
// The partial unique index that allows one pending invitation per tenant and address.
const PENDING_UNIQUE_CONSTRAINT = 'tenant_invitations_pending_unique'

/**
 * Whether an error is (or wraps) a Postgres unique violation of one named
 * constraint. Adapted from the check in user-membership.repository.ts: a
 * table outside BaseRepository re-implements it rather than exporting an
 * internal.
 * @param error - The error thrown by the insert.
 * @param constraintName - The unique index or constraint that must have been violated.
 * @returns True when the error is a 23505 on `constraintName`.
 */
function isUniqueViolationOf(error: unknown, constraintName: string): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  return (
    cause instanceof postgres.PostgresError &&
    cause.code === UNIQUE_VIOLATION_CODE &&
    cause.constraint_name === constraintName
  )
}

const invitation = tenantInvitationModel

// `invitedBy` once the inviter's account is gone. The API contract is
// `… | null`, because JSON has no undefined.
// eslint-disable-next-line unicorn/no-null -- see the comment above
const NO_INVITER = null

/**
 * The row is still pending: neither accepted nor revoked. Says nothing about
 * expiry.
 * @returns The SQL condition.
 */
function pendingCondition() {
  return and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt))
}

/**
 * The row is still pending and has not expired, by the database clock.
 * @returns The SQL condition.
 */
function redeemableCondition() {
  return and(pendingCondition(), gt(invitation.expiresAt, sql`now()`))
}

/**
 * What `createPending` writes. The caller must pass `email` already trimmed
 * and lowercased; nothing below normalises it.
 */
export interface NewPendingInvitation {
  tenantId: string
  email: string
  role: MembershipRole
  tokenHash: string
  invitedBy: string
  expiresAt: Date
}

/**
 * One pending invitation as the list endpoint returns it. Never carries the
 * token hash.
 */
export interface PendingInvitationSummary {
  id: string
  email: string
  role: MembershipRole
  /**
   * The inviter, or null once their account is deleted.
   */
  invitedBy: { id: string; firstName: string | null; lastName: string | null } | null
  expiresAt: Date
  createdAt: Date
}

/**
 * An invitation with the (not soft-deleted) tenant it is for.
 */
export interface InvitationWithTenant {
  invitation: TenantInvitation
  tenant: { id: string; name: string; slug: string }
}

/**
 * A redeemable invitation, its tenant, and its inviter's name.
 */
export interface ValidInvitation extends InvitationWithTenant {
  /**
   * The inviter's name, or null once their account is deleted.
   */
  invitedBy: { firstName: string | null; lastName: string | null } | null
}

/**
 * Query access to the `tenant_invitations` table.
 */
export class TenantInvitationRepository {
  /**
   * Revoke any pending invitation for this tenant and address, then insert a
   * new one. Call it inside a transaction so the two writes commit together.
   * @param input - The new invitation's columns.
   * @param executor - Where to run the queries. Defaults to the pool.
   * @returns The inserted row.
   * @throws {HttpError} 409 `invitation_conflict`, when the insert violates `tenant_invitations_pending_unique` because a concurrent invite of the same address committed first. Any other error, including another 23505, is rethrown unchanged.
   */
  async createPending(
    input: NewPendingInvitation,
    executor: DbExecutor = db
  ): Promise<TenantInvitation> {
    await executor
      .update(invitation)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(invitation.tenantId, input.tenantId),
          sql`lower(${invitation.email}) = lower(${input.email})`,
          pendingCondition()
        )
      )
    try {
      const [row] = await executor.insert(invitation).values(input).returning()
      if (!row) throw new HttpError('Insert returned no row', 500)
      return row
    } catch (error) {
      if (isUniqueViolationOf(error, PENDING_UNIQUE_CONSTRAINT)) {
        throw new HttpError(
          'An invitation to that address is already being sent. Try again.',
          409,
          'invitation_conflict'
        )
      }
      throw error
    }
  }

  /**
   * A tenant's pending, unexpired invitations, newest first, with each
   * inviter's name.
   * @param tenantId - The tenant.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns One summary per invitation.
   */
  async listPending(
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<PendingInvitationSummary[]> {
    const rows = await executor
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterId: userModel.id,
        inviterFirstName: userModel.firstName,
        inviterLastName: userModel.lastName,
      })
      .from(invitation)
      .leftJoin(userModel, and(eq(invitation.invitedBy, userModel.id), isNull(userModel.deletedAt)))
      .where(and(eq(invitation.tenantId, tenantId), redeemableCondition()))
      .orderBy(desc(invitation.createdAt), desc(invitation.id))
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      invitedBy:
        row.inviterId === null
          ? NO_INVITER
          : { id: row.inviterId, firstName: row.inviterFirstName, lastName: row.inviterLastName },
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }))
  }

  /**
   * One pending (not accepted, not revoked) invitation of this tenant,
   * expired or not.
   * @param tenantId - The tenant it must belong to.
   * @param id - The invitation id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The row, or undefined when there is no such pending invitation in this tenant.
   */
  async findPendingById(
    tenantId: string,
    id: string,
    executor: DbExecutor = db
  ): Promise<TenantInvitation | undefined> {
    const [row] = await executor
      .select()
      .from(invitation)
      .where(and(eq(invitation.tenantId, tenantId), eq(invitation.id, id), pendingCondition()))
    return row
  }

  /**
   * A redeemable invitation by its token hash: pending, not expired, and for
   * a tenant that is not soft-deleted.
   * @param tokenHash - SHA-256 hex of the raw token.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The invitation with its tenant and inviter, or undefined.
   */
  async findValidByTokenHash(
    tokenHash: string,
    executor: DbExecutor = db
  ): Promise<ValidInvitation | undefined> {
    const [row] = await executor
      .select({
        invitation,
        tenant: { id: tenantModel.id, name: tenantModel.name, slug: tenantModel.slug },
        inviterId: userModel.id,
        inviterFirstName: userModel.firstName,
        inviterLastName: userModel.lastName,
      })
      .from(invitation)
      .innerJoin(
        tenantModel,
        and(eq(invitation.tenantId, tenantModel.id), isNull(tenantModel.deletedAt))
      )
      .leftJoin(userModel, and(eq(invitation.invitedBy, userModel.id), isNull(userModel.deletedAt)))
      .where(and(eq(invitation.tokenHash, tokenHash), redeemableCondition()))
      .limit(1)
    if (!row) return undefined
    return {
      invitation: row.invitation,
      tenant: row.tenant,
      invitedBy:
        row.inviterId === null
          ? NO_INVITER
          : { firstName: row.inviterFirstName, lastName: row.inviterLastName },
    }
  }

  /**
   * An invitation by its token hash in any state, for a tenant that is not
   * soft-deleted. The hash column is unique, so there is at most one.
   * @param tokenHash - SHA-256 hex of the raw token.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The invitation with its tenant, or undefined.
   */
  async findByTokenHash(
    tokenHash: string,
    executor: DbExecutor = db
  ): Promise<InvitationWithTenant | undefined> {
    const [row] = await executor
      .select({
        invitation,
        tenant: { id: tenantModel.id, name: tenantModel.name, slug: tenantModel.slug },
      })
      .from(invitation)
      .innerJoin(
        tenantModel,
        and(eq(invitation.tenantId, tenantModel.id), isNull(tenantModel.deletedAt))
      )
      .where(eq(invitation.tokenHash, tokenHash))
      .limit(1)
    return row
  }

  /**
   * Atomically mark a redeemable invitation accepted by `userId`. The check
   * and the write are one UPDATE, so of two concurrent claims exactly one
   * gets the row. Unlike `claimOnce`, expiry is part of the predicate, and
   * so is the tenant not being soft-deleted.
   * @param tokenHash - SHA-256 hex of the raw token.
   * @param userId - The accepting user.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The claimed row, or undefined when it was not redeemable at that instant.
   */
  async claimForAccept(
    tokenHash: string,
    userId: string,
    executor: DbExecutor = db
  ): Promise<TenantInvitation | undefined> {
    const [row] = await executor
      .update(invitation)
      .set({ acceptedAt: sql`now()`, acceptedBy: userId, updatedAt: sql`now()` })
      .where(
        and(
          eq(invitation.tokenHash, tokenHash),
          redeemableCondition(),
          sql`exists (select 1 from ${tenantModel} where ${tenantModel.id} = ${invitation.tenantId} and ${tenantModel.deletedAt} is null)`
        )
      )
      .returning()
    return row
  }

  /**
   * Give a pending invitation a new token and expiry. The old token stops
   * resolving at once.
   * @param id - The invitation id.
   * @param tokenHash - SHA-256 hex of the new raw token.
   * @param expiresAt - The new expiry.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when the invitation is not pending.
   */
  async replaceToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
    executor: DbExecutor = db
  ): Promise<TenantInvitation | undefined> {
    const [row] = await executor
      .update(invitation)
      .set({ tokenHash, expiresAt, updatedAt: sql`now()` })
      .where(and(eq(invitation.id, id), pendingCondition()))
      .returning()
    return row
  }

  /**
   * Revoke one pending invitation of this tenant.
   * @param tenantId - The tenant it must belong to.
   * @param id - The invitation id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when a pending row was revoked; false otherwise.
   */
  async revoke(tenantId: string, id: string, executor: DbExecutor = db): Promise<boolean> {
    const rows = await executor
      .update(invitation)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(invitation.tenantId, tenantId), eq(invitation.id, id), pendingCondition()))
      .returning({ id: invitation.id })
    return rows.length > 0
  }
}
