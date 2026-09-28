/**
 * @file The `user_memberships` table: which tenants a user belongs to, and
 * at which role.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'

/**
 * `MEMBERSHIP_ROLES` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const MEMBERSHIP_ROLE_SQL_LIST = MEMBERSHIP_ROLES.map((role) => `'${role}'`).join(', ')

/**
 * The `user_memberships` table: one row per (user, tenant) pair, carrying
 * that user's role within that tenant. `TenantRepository.create()` inserts
 * the creator's `'owner'` row with the tenant; an accepted invitation adds
 * one through `createIfAbsent` (tenant-invitation.service.ts), and
 * platform.service.ts adds platform-tenant rows by auto-join
 * (`insertIfAbsent`) and by explicit grant (`create`). Removing a member is
 * a hard delete, so `UserMembershipRepository` does not extend
 * `BaseRepository`.
 */
export const userMembershipModel = pgTable(
  'user_memberships',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    /**
     * varchar with a CHECK, as for `user_tokens.purpose`. Defaults to the
     * least-privileged role, so an insert that names none never grants more
     * than read access.
     */
    role: varchar('role', { length: 20 }).$type<MembershipRole>().notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The conflict target createIfAbsent relies on: one role per user per tenant.
    uniqueIndex('user_memberships_user_id_tenant_id_unique').on(table.userId, table.tenantId),
    index('user_memberships_tenant_id_idx').on(table.tenantId),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
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
