/**
 * @file The `onboarding_completions` table: one append-only row per completed
 * onboarding step, per tenant (tenant steps) or per member (member steps).
 * A row whose step left the registry is kept and ignored on read.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import {
  ONBOARDING_REASON_MAX_LENGTH,
  ONBOARDING_SOURCES,
  ONBOARDING_STEP_KEY_MAX_LENGTH,
  type OnboardingSource,
} from '@/constants/onboarding.constants'
import { tenantModel } from '@/database/models/tenant.model'
import { userModel } from '@/database/models/user.model'

/**
 * `ONBOARDING_SOURCES` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const ONBOARDING_SOURCE_SQL_LIST = ONBOARDING_SOURCES.map((source) => `'${source}'`).join(', ')

/**
 * The `onboarding_completions` table. A tenant's purge removes its rows; a
 * user's purge removes their member-step rows and clears `completed_by`.
 */
export const onboardingCompletionModel = pgTable(
  'onboarding_completions',
  {
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenantModel.id, { onDelete: 'cascade' }),
    /**
     * The member who did a member step; null for a tenant step.
     */
    userId: varchar('user_id', { length: 36 }).references(() => userModel.id, {
      onDelete: 'cascade',
    }),
    stepKey: varchar('step_key', { length: ONBOARDING_STEP_KEY_MAX_LENGTH }).notNull(),
    source: varchar('source', { length: 16 }).$type<OnboardingSource>().notNull(),
    /**
     * The customer or staff user who recorded it; null for `auto`, and once
     * that user is purged.
     */
    completedBy: varchar('completed_by', { length: 36 }).references(() => userModel.id, {
      onDelete: 'set null',
    }),
    /**
     * The staff reason; required when `source` is `staff`.
     */
    reason: varchar('reason', { length: ONBOARDING_REASON_MAX_LENGTH }),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One completion per step per tenant (user_id null) or per member; the conflict target insertIfNew relies on.
    uniqueIndex('onboarding_completions_step_unique').on(
      table.tenantId,
      sql`coalesce(${table.userId}, '')`,
      table.stepKey
    ),
    index('onboarding_completions_user_id_idx').on(table.userId),
    index('onboarding_completions_completed_by_idx').on(table.completedBy),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'onboarding_completions_source_check',
      sql`${table.source} in (${sql.raw(ONBOARDING_SOURCE_SQL_LIST)})`
    ),
    check(
      'onboarding_completions_staff_reason_check',
      sql`${table.source} <> 'staff' or ${table.reason} is not null`
    ),
    check(
      'onboarding_completions_auto_actor_check',
      sql`${table.source} <> 'auto' or ${table.completedBy} is null`
    ),
    check(
      'onboarding_completions_step_key_check',
      sql`${table.stepKey} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'`
    ),
  ]
)

/**
 * An onboarding_completions row as read from the database.
 */
export type OnboardingCompletion = InferSelectModel<typeof onboardingCompletionModel>

/**
 * An onboarding_completions row as written to the database.
 */
export type NewOnboardingCompletion = InferInsertModel<typeof onboardingCompletionModel>
