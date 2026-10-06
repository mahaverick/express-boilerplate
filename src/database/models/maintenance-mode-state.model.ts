/**
 * @file The `maintenance_mode_state` table: the one row holding the
 * platform's maintenance mode, the source of truth every replica's
 * in-memory store reloads. Migration 0024 inserts the row (mode `off`,
 * version 0); no code inserts or deletes one. History lives in the audit log.
 */
import { sql, type InferSelectModel } from 'drizzle-orm'
import { check, integer, pgTable, smallint, text, timestamp, varchar } from 'drizzle-orm/pg-core'
import {
  MAINTENANCE_MODE_TEXT_MAX_LENGTH,
  MAINTENANCE_MODES,
  type MaintenanceMode,
} from '@/constants/maintenance-mode.constants'
import { userModel } from '@/database/models/user.model'

/**
 * `MAINTENANCE_MODES` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const MODE_SQL_LIST = MAINTENANCE_MODES.map((mode) => `'${mode}'`).join(', ')

/**
 * The `maintenance_mode_state` table.
 */
export const maintenanceModeState = pgTable(
  'maintenance_mode_state',
  {
    /**
     * Always 1 (`maintenance_mode_state_single_row_check`).
     */
    id: smallint('id').primaryKey(),
    mode: text('mode').$type<MaintenanceMode>().notNull(),
    /**
     * The customer-facing message, plain text; null only while `off`.
     */
    message: text('message'),
    /**
     * The internal reason given when the current mode was set, if any; a save that keeps the mode keeps it unless a new reason is sent.
     */
    reason: text('reason'),
    /**
     * The staff member who set the current mode (a save that keeps the mode leaves it); null for the seeded row, and
     * once that user is purged.
     */
    changedBy: varchar('changed_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    changedAt: timestamp('changed_at', { withTimezone: true, precision: 3 }).notNull(),
    /**
     * Incremented by every change; the compare-and-set token and the
     * replicas' ordering rule.
     */
    version: integer('version').notNull(),
  },
  (table) => [
    check('maintenance_mode_state_single_row_check', sql`${table.id} = 1`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check('maintenance_mode_state_mode_check', sql`${table.mode} in (${sql.raw(MODE_SQL_LIST)})`),
    check(
      'maintenance_mode_state_message_check',
      sql`(${table.mode} = 'off' or ${table.message} is not null) and char_length(${table.message}) <= ${sql.raw(String(MAINTENANCE_MODE_TEXT_MAX_LENGTH))}`
    ),
    check(
      'maintenance_mode_state_reason_check',
      sql`char_length(${table.reason}) <= ${sql.raw(String(MAINTENANCE_MODE_TEXT_MAX_LENGTH))}`
    ),
    check('maintenance_mode_state_version_check', sql`${table.version} >= 0`),
  ]
)

/**
 * The maintenance_mode_state row as read from the database.
 */
export type MaintenanceModeStateRow = InferSelectModel<typeof maintenanceModeState>
