// src/repositories/user-membership.repository.ts
//
// Deliberately does NOT extend BaseRepository — see
// user-membership.model.ts's own header comment: no soft-delete concept,
// no `deletedAt` column, and `delete` below is a genuine hard delete.
//
// `listByTenant` joins in only `id`/`email`/`firstName`/`lastName` from
// `users` — NEVER `passwordHash` — via an explicit column-projection object
// (`{ id: userModel.id, email: userModel.email, ... }`), not
// `.select({ membership: userMembershipModel, user: userModel })` (which
// would select every `users` column, `passwordHash` included, into the
// response a later task's "list members" endpoint serializes straight to
// JSON).
import { and, count, DrizzleQueryError, eq, isNull, sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { MembershipRole } from '@/constants/tenant.constants'
import { tenantModel, type Tenant } from '@/database/models/tenant.model'
import {
  userMembershipModel,
  type NewUserMembership,
  type UserMembership,
} from '@/database/models/user-membership.model'
import { userModel, type User } from '@/database/models/user.model'
import { HttpError } from '@/middlewares/error.middleware'
import { db, type DbExecutor } from '@/services/database.service'

// Postgres error code for a unique-constraint violation. Same source and
// same value as base.repository.ts's own — see that file's comment for the
// PostgreSQL docs reference.
const UNIQUE_VIOLATION_CODE = '23505'

/**
 * Whether an error thrown by `create` is a Postgres unique-constraint
 * violation — i.e. `user_memberships_user_id_tenant_id_unique`
 * (user-membership.model.ts) already has a row for this `(userId,
 * tenantId)` pair. A deliberate copy of `BaseRepository`'s
 * identically-named private helper, not an import — see
 * `auth-provider.repository.ts`'s own header comment for why a table that
 * cannot extend `BaseRepository` re-implements this three-line check
 * rather than exporting an internal.
 * @param error - The error thrown by the insert.
 * @returns True when the error is (or wraps) a 23505 unique violation.
 */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error
  return cause instanceof postgres.PostgresError && cause.code === UNIQUE_VIOLATION_CODE
}

/**
 * One `user_memberships` row for `listByTenant`, joined with the subset of
 * its user's columns safe to return over the wire — see this file's header
 * comment for why this is an explicit projection, not the full `User` row.
 */
export interface MembershipWithUser {
  /**
   * The membership row itself (role, timestamps, ids).
   */
  membership: UserMembership
  /**
   * The member's public identity — never `passwordHash`.
   */
  user: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'>
}

/**
 * One `user_memberships` row for `listByUser`, joined with the tenant it
 * belongs to.
 */
export interface MembershipWithTenant {
  /**
   * The membership row itself (role, timestamps, ids).
   */
  membership: UserMembership
  /**
   * The tenant this membership grants access to.
   */
  tenant: Tenant
}

/**
 * Query access to the `user_memberships` table: lookup a single
 * membership, list a tenant's members (with safe user info) or a user's
 * memberships (with tenant info), create/update/delete a membership, and
 * count a tenant's owners for the "can't remove the last owner" safety
 * check (`tenant-membership.service.ts`).
 */
export class UserMembershipRepository {
  /**
   * Find the single membership row for one (user, tenant) pair — the
   * lookup `resolveTenant` (a later task's middleware) makes to decide
   * whether a user may access a tenant-scoped route at all.
   * @param userId - The user to look up.
   * @param tenantId - The tenant to look up.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The matching row, or undefined when this user has no membership in this tenant.
   */
  async findByUserAndTenant(
    userId: string,
    tenantId: string,
    executor: DbExecutor = db
  ): Promise<UserMembership | undefined> {
    const [row] = await executor
      .select()
      .from(userMembershipModel)
      .where(
        and(eq(userMembershipModel.userId, userId), eq(userMembershipModel.tenantId, tenantId))
      )
    return row
  }

  /**
   * Every member of one tenant, with each member's safe user info attached
   * — the query `GET /tenants/:slug/members` (a later task's controller)
   * runs. A user whose own account is soft-deleted is excluded (a stale
   * membership row pointing at a soft-deleted user is not a real,
   * displayable member) — nothing prunes the membership row itself when a
   * user is soft-deleted, so this filter is what keeps a "deleted" account
   * from still appearing in a member list.
   * @param tenantId - The tenant whose members to list.
   * @returns One entry per member, in no particular guaranteed order.
   */
  async listByTenant(tenantId: string): Promise<MembershipWithUser[]> {
    return db
      .select({
        membership: userMembershipModel,
        user: {
          id: userModel.id,
          email: userModel.email,
          firstName: userModel.firstName,
          lastName: userModel.lastName,
        },
      })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userMembershipModel.userId, userModel.id))
      .where(and(eq(userMembershipModel.tenantId, tenantId), isNull(userModel.deletedAt)))
  }

  /**
   * Every tenant one user is a member of, with the tenant row and this
   * user's role in it attached. Companion to `TenantRepository.listForUser`
   * (tenant.repository.ts), which answers the same question keyed the
   * other way round (one `Tenant` per row, with `role` attached rather
   * than the full membership) — this method exists for a call site that
   * needs the membership row itself (its `id`, `createdAt`, etc.), not just
   * the role. A soft-deleted tenant is excluded, same as
   * `TenantRepository.listForUser`.
   * @param userId - The user whose memberships to list.
   * @returns One entry per (still visible) tenant this user belongs to, in no particular guaranteed order.
   */
  async listByUser(userId: string): Promise<MembershipWithTenant[]> {
    return db
      .select({ membership: userMembershipModel, tenant: tenantModel })
      .from(userMembershipModel)
      .innerJoin(tenantModel, eq(userMembershipModel.tenantId, tenantModel.id))
      .where(and(eq(userMembershipModel.userId, userId), isNull(tenantModel.deletedAt)))
  }

  /**
   * Add a member to a tenant.
   *
   * Translates a 23505 on `(userId, tenantId)` into `HttpError(409)` rather
   * than letting the raw driver error escape — the same translation
   * `BaseRepository.create` gives every table that extends it, applied by
   * hand here since this table cannot (see this file's header comment). A
   * caller that hits this should treat it as "already a member", not as an
   * unexpected failure.
   * @param data - The row's initial column values.
   * @returns The inserted row.
   */
  async create(data: NewUserMembership): Promise<UserMembership> {
    try {
      const [row] = await db.insert(userMembershipModel).values(data).returning()
      // db.insert(...).values(one object).returning() always returns
      // exactly one row when the insert does not throw — same reasoning as
      // UserRepository.insertOne (user.repository.ts).
      if (row === undefined) throw new HttpError('Insert returned no row', 500)
      return row
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError('This user is already a member of this tenant', 409)
      }
      throw error
    }
  }

  /**
   * Change one membership's role.
   * @param id - The membership row's id.
   * @param role - The new role.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The updated row, or undefined when no membership with this id exists.
   */
  async updateRole(
    id: string,
    role: MembershipRole,
    executor: DbExecutor = db
  ): Promise<UserMembership | undefined> {
    const [row] = await executor
      .update(userMembershipModel)
      .set({ role, updatedAt: sql`now()` })
      .where(eq(userMembershipModel.id, id))
      .returning()
    return row
  }

  /**
   * Remove a member from a tenant — a hard delete, not a soft one (see
   * this file's header comment).
   * @param id - The membership row's id.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns True when a row was deleted; false when no membership with this id existed.
   */
  async delete(id: string, executor: DbExecutor = db): Promise<boolean> {
    const result = await executor.delete(userMembershipModel).where(eq(userMembershipModel.id, id))
    // The postgres-js driver's own result for a write with no
    // `.returning()` exposes the affected-row count as `.count` — see
    // NotificationRepository.markAllRead's own comment (notification
    // .repository.ts) for why this is `.count`, not `.rowCount`.
    return result.count > 0
  }

  /**
   * How many live owners a tenant has. An owner whose user is soft-deleted
   * cannot act and is not counted, so a tenant is never left with only a
   * deleted owner. `count()` maps to a JS number itself.
   * @param tenantId - The tenant to count owners for.
   * @param executor - Where to run the query. Defaults to the pool.
   * @returns The number of owner memberships whose user is not soft-deleted.
   */
  async countOwners(tenantId: string, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
      .select({ count: count() })
      .from(userMembershipModel)
      .innerJoin(userModel, eq(userMembershipModel.userId, userModel.id))
      .where(
        and(
          eq(userMembershipModel.tenantId, tenantId),
          eq(userMembershipModel.role, 'owner'),
          isNull(userModel.deletedAt)
        )
      )
    return row?.count ?? 0
  }

  /**
   * Lock a tenant's owner memberships until the transaction ends
   * (`SELECT … FOR UPDATE`, in id order so two lockers never deadlock). A
   * concurrent demotion or removal of an owner waits here, which is what
   * makes the last-owner check atomic. Only meaningful inside a
   * transaction.
   * @param tenantId - The tenant whose owners to lock.
   * @param executor - The transaction to hold the lock in.
   * @returns The locked owner memberships.
   */
  async lockOwners(tenantId: string, executor: DbExecutor = db): Promise<UserMembership[]> {
    return executor
      .select()
      .from(userMembershipModel)
      .where(and(eq(userMembershipModel.tenantId, tenantId), eq(userMembershipModel.role, 'owner')))
      .orderBy(userMembershipModel.id)
      .for('update')
  }
}
