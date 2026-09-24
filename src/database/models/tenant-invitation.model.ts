// src/database/models/tenant-invitation.model.ts
//
// One row per invitation to join a tenant. Only the SHA-256 hash of the
// token is stored; the raw token exists only in the mailed link. No
// `deletedAt`: an invitation ends by being accepted or revoked, so
// `TenantInvitationRepository` does not extend `BaseRepository`.
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import { MEMBERSHIP_ROLES, type MembershipRole } from '@/constants/tenant.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'

// Pre-rendered for the CHECK below; nesting it inside the `sql` template
// trips sonarjs/no-nested-template-literals (as in user-membership.model.ts).
const MEMBERSHIP_ROLE_SQL_LIST = MEMBERSHIP_ROLES.map((role) => `'${role}'`).join(', ')

/**
 * The `tenant_invitations` table: an offer of a role in a tenant, made to an
 * email address, redeemable once by the signed-in owner of that address.
 */
export const tenantInvitationModel = pgTable(
  'tenant_invitations',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    // Stored lowercased and trimmed; the same width as users.email, so any
    // address that can register can be invited.
    email: varchar('email', { length: MAX_EMAIL_LENGTH }).notNull(),
    role: varchar('role', { length: 20 }).$type<MembershipRole>().notNull(),
    // 64 hex characters: a SHA-256 digest, never the token itself.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    invitedBy: varchar('invited_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: varchar('accepted_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenant_invitations_token_hash_unique').on(table.tokenHash),
    // At most one pending invitation per tenant and address. The predicate
    // cannot test expiry (now() is not immutable), so an expired row still
    // holds the slot until `createPending` revokes it.
    uniqueIndex('tenant_invitations_pending_unique')
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    // `sql.raw`: a DDL CHECK has no parameter list to bind against. Safe,
    // because every value comes from the code-defined MEMBERSHIP_ROLES.
    check(
      'tenant_invitations_role_check',
      sql`${table.role} in (${sql.raw(MEMBERSHIP_ROLE_SQL_LIST)})`
    ),
  ]
)

/**
 * A tenant_invitations row as read from the database.
 */
export type TenantInvitation = InferSelectModel<typeof tenantInvitationModel>

/**
 * A tenant_invitations row as written to the database.
 */
export type NewTenantInvitation = InferInsertModel<typeof tenantInvitationModel>
