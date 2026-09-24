// src/database/models/user-membership.model.ts
//
// One row per (user, tenant) pair — what makes a user a member of an
// organization at all, and at which of the five roles
// (`@/constants/tenant.constants`'s `MEMBERSHIP_ROLES`). A user with
// memberships in three tenants has three rows here, each independently
// roled — the same "join table carries the relationship's own attributes"
// shape `auth_providers` uses for (user, login method).
//
// NO `deletedAt`: removing a member is a hard delete
// (`UserMembershipRepository.delete`), not a soft one — a departed
// member's row is not a "recoverable" state this codebase models (compare
// `auth_providers`' identical no-soft-delete reasoning, whose own header
// comment this one mirrors). `UserMembershipRepository` does not extend
// `BaseRepository` accordingly (`SoftDeletableTableConfig` requires a
// `deletedAt` column this table deliberately has none of).
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'

// `MEMBERSHIP_ROLES`, pre-rendered as a literal SQL value list — `'owner',
// 'admin', 'manager', 'editor', 'viewer'` — for
// `user_memberships_role_check` below. Built once, here, rather than
// inline inside that `sql` template: nesting this array's own template
// literal inside the check constraint's `sql\`...\`` template trips
// `sonarjs/no-nested-template-literals` — same reasoning as
// `AUTH_PROVIDER_SQL_LIST` in auth-provider.model.ts.
const MEMBERSHIP_ROLE_SQL_LIST = MEMBERSHIP_ROLES.map((role) => `'${role}'`).join(', ')

/**
 * The `user_memberships` table: one row per (user, tenant) pair, carrying
 * that user's role within that tenant. `TenantRepository.create()`
 * (tenant.repository.ts) inserts the creator's `'owner'` row atomically
 * alongside the tenant itself; every other row comes from
 * `UserMembershipRepository.createIfAbsent`, when an invitation is accepted
 * (tenant-invitation.service.ts).
 */
export const userMembershipModel = pgTable(
  'user_memberships',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without
    // leaking a row count the way a serial does — same choice as every
    // other table's id.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    // 'owner' | 'admin' | 'manager' | 'editor' | 'viewer'. varchar +
    // $type<>(), NOT pgEnum — matching every other small fixed-set column
    // in this codebase (`auth_providers.provider`, `email_logs.status`),
    // plus the CHECK constraint below: `$type<>()` alone is
    // compile-time-only narrowing, and a raw SQL statement is not bound by
    // it. Defaults to the least-privileged role — a caller that adds a
    // member without specifying a role should never accidentally grant
    // more than read access.
    role: varchar('role', { length: 20 }).$type<MembershipRole>().notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One role per tenant per user — the constraint
    // `UserMembershipRepository.create` depends on translating a violation
    // of into `HttpError(409)` (adding a user who is already a member),
    // and what stops a user from accumulating two different roles in the
    // same tenant.
    uniqueIndex('user_memberships_user_id_tenant_id_unique').on(table.userId, table.tenantId),
    // `listByTenant` (user-membership.repository.ts) filters on this
    // column alone across potentially many rows; not indexed automatically
    // just by virtue of being a foreign key.
    index('user_memberships_tenant_id_idx').on(table.tenantId),
    // The database-level half of `role`'s validity check — see that
    // column's own comment, and `AUTH_PROVIDER_SQL_LIST`'s comment in
    // auth-provider.model.ts for the fuller version of this reasoning.
    // `sql.raw`, not `sql`-tagged interpolation: a CHECK constraint's
    // expression is fixed at DDL time and has no parameter list to bind
    // against — safe here because every value comes from the fixed,
    // code-defined `MEMBERSHIP_ROLES` array, never external input.
    check(
      'user_memberships_role_check',
      sql`${table.role} in (${sql.raw(MEMBERSHIP_ROLE_SQL_LIST)})`
    ),
  ]
)

/**
 * A user_memberships row as read from the database.
 */
export type UserMembership = InferSelectModel<typeof userMembershipModel>

/**
 * A user_memberships row as written to the database.
 */
export type NewUserMembership = InferInsertModel<typeof userMembershipModel>
