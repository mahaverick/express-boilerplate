/**
 * @file The `audit_logs` table. Append-only: the `audit_logs_immutable`
 * trigger rejects every UPDATE except a staff purge's redaction of the actor
 * columns (migration 0019), and every DELETE outside a retention purge or a
 * tenant purge. Both foreign keys are RESTRICT, so no cascade reaches it: a
 * purge redacts or deletes first.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import {
  AUDIT_ACCESS_KINDS,
  AUDIT_ACTOR_KINDS,
  AUDIT_TARGET_TYPES,
  type AuditAccess,
  type AuditAction,
  type AuditActorKind,
  type AuditTargetType,
} from '@/constants/audit.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'

/**
 * Render a fixed, code-defined value list as SQL literals for a CHECK.
 * @param values - The allowed values.
 * @returns The values quoted and comma-separated.
 */
function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * The `audit_logs` table: one row per audited change or staff visit.
 */
export const auditLogModel = pgTable(
  'audit_logs',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    /**
     * Millisecond precision, so a keyset cursor round-trips through a JS Date exactly.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    actorKind: varchar('actor_kind', { length: 10 }).$type<AuditActorKind>().notNull(),
    actorUserId: varchar('actor_user_id', { length: 36 }).references(() => userModel.id, {
      onDelete: 'restrict',
    }),
    access: varchar('access', { length: 10 }).$type<AuditAccess>().notNull(),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 64 }).$type<AuditAction>().notNull(),
    targetType: varchar('target_type', { length: 32 }).$type<AuditTargetType>(),
    targetId: varchar('target_id', { length: 36 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    requestId: varchar('request_id', { length: 64 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
  },
  (table) => [
    // Ascending: a backward scan serves ORDER BY occurred_at DESC, id DESC; DESC NULLS LAST would not.
    index('audit_logs_tenant_occurred_idx').on(table.tenantId, table.occurredAt, table.id),
    index('audit_logs_actor_occurred_idx').on(table.actorUserId, table.occurredAt, table.id),
    index('audit_logs_occurred_idx').on(table.occurredAt, table.id),
    index('audit_logs_target_occurred_idx').on(table.targetId, table.occurredAt, table.id),
    // `sql.raw` is safe here: every value comes from a code-defined constant.
    check(
      'audit_logs_actor_kind_check',
      sql`${table.actorKind} in (${sql.raw(sqlValueList(AUDIT_ACTOR_KINDS))})`
    ),
    check(
      'audit_logs_access_check',
      sql`${table.access} in (${sql.raw(sqlValueList(AUDIT_ACCESS_KINDS))})`
    ),
    // A system entry never names a user. A user entry names one until a purge redacts it (0019).
    check(
      'audit_logs_actor_user_check',
      sql`${table.actorKind} <> 'system' or ${table.actorUserId} is null`
    ),
    check('audit_logs_action_check', sql`${table.action} ~ '^[a-z]+(\\.[a-z_]+)+$'`),
    check(
      'audit_logs_target_type_check',
      sql`${table.targetType} is null or ${table.targetType} in (${sql.raw(sqlValueList(AUDIT_TARGET_TYPES))})`
    ),
    check(
      'audit_logs_target_check',
      sql`(${table.targetType} is null) = (${table.targetId} is null)`
    ),
  ]
)

/**
 * An audit_logs row as read from the database.
 */
export type AuditLog = InferSelectModel<typeof auditLogModel>

/**
 * An audit_logs row as written to the database.
 */
export type NewAuditLog = InferInsertModel<typeof auditLogModel>
