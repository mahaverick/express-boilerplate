// src/database/models/tenant.model.ts
//
// Two tables: `tenants` (the organization itself) and `tenant_settings`
// (its one-to-one configuration row). Kept in one file, not two, because
// `TenantRepository.create()` (tenant.repository.ts) inserts into both
// inside a single transaction and the two tables have no independent
// lifecycle from each other — a settings row without a tenant is
// meaningless, and a tenant is never expected to exist without one. This
// mirrors how `notification.model.ts` already holds two closely-related
// tables (`notifications` + `notification_preferences`) in one file.
import { isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, jsonb, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { TENANT_LIFECYCLE_STATES } from '@/constants/tenant.constants'

// `TENANT_LIFECYCLE_STATES`, pre-rendered as a literal SQL value list —
// `'active', 'suspended', 'archived'` — for `tenants_lifecycle_state_check`
// below. Built once, here, rather than inline inside that `sql` template:
// nesting this array's own template literal inside the check constraint's
// `sql\`...\`` template trips `sonarjs/no-nested-template-literals` — same
// reasoning as `AUTH_PROVIDER_SQL_LIST` in auth-provider.model.ts.
const TENANT_LIFECYCLE_STATE_SQL_LIST = TENANT_LIFECYCLE_STATES.map((state) => `'${state}'`).join(
  ', '
)

/**
 * The `tenants` table: one row per organization. Soft-deletable (has
 * `deletedAt`) — a deleted tenant's row (and everything a derived project
 * scopes to it via `tenantId`) is retained, not erased, mirroring
 * `users`' own soft-delete story. `lifecycleState` is a SEPARATE concept
 * from `deletedAt`: `archived` is the terminal state a tenant reaches
 * alongside a soft-delete, but `suspended` (a billing hold, e.g.) is not a
 * deletion at all — the row stays fully intact and merely gates access.
 * `TenantRepository` (tenant.repository.ts) extends `BaseRepository`
 * because this table has both columns `SoftDeletableTableConfig` requires
 * (`deletedAt`, `updatedAt`); `findActiveBySlug` layers the
 * `lifecycleState = 'active'` check on top of the soft-delete scope
 * `BaseRepository` already gives every lookup.
 */
export const tenantModel = pgTable(
  'tenants',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking
    // a row count the way a serial does — same choice as every other
    // table's id.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    name: varchar('name', { length: 255 }).notNull(),
    // URL-safe identifier — `/tenants/:slug/...` (a later task's routes).
    // Uniqueness is enforced by `tenants_slug_unique` below, not a plain
    // NOT NULL + column-level unique: it must be a PARTIAL index (`WHERE
    // deleted_at IS NULL`) so a re-registered slug can reclaim a name an
    // archived tenant no longer uses, the same reasoning as
    // `users_email_unique` (`archived` is a real, expected terminal state
    // here, not an edge case).
    slug: varchar('slug', { length: 100 }).notNull(),
    description: varchar('description', { length: 1000 }),
    // URL to a logo image — not the image itself; this table never stores
    // binary data.
    logo: varchar('logo', { length: 255 }),
    website: varchar('website', { length: 255 }),
    // 'active' | 'suspended' | 'archived'. varchar + $type<>(), NOT pgEnum
    // — matching every other small fixed-set column in this codebase
    // (`auth_providers.provider`, `email_logs.status`), plus the CHECK
    // constraint below: `$type<>()` alone is compile-time-only narrowing,
    // and a raw SQL statement is not bound by it.
    lifecycleState: varchar('lifecycle_state', { length: 20 })
      .$type<(typeof TENANT_LIFECYCLE_STATES)[number]>()
      .notNull()
      .default('active'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Partial: only a currently-visible tenant's slug is protected. A
    // soft-deleted (`archived`) tenant's slug becomes free for a new
    // registration to reclaim — see the `slug` column's own comment.
    uniqueIndex('tenants_slug_unique').on(table.slug).where(isNull(table.deletedAt)),
    // The database-level half of `lifecycleState`'s validity check — see
    // that column's own comment, and `AUTH_PROVIDER_SQL_LIST`'s comment in
    // auth-provider.model.ts for the fuller version of this reasoning.
    // `sql.raw`, not `sql`-tagged interpolation: a CHECK constraint's
    // expression is fixed at DDL time and has no parameter list to bind
    // against — safe here because every value comes from the fixed,
    // code-defined `TENANT_LIFECYCLE_STATES` array, never external input.
    check(
      'tenants_lifecycle_state_check',
      sql`${table.lifecycleState} in (${sql.raw(TENANT_LIFECYCLE_STATE_SQL_LIST)})`
    ),
  ]
)

/**
 * A tenants row as read from the database.
 */
export type Tenant = InferSelectModel<typeof tenantModel>

/**
 * A tenants row as written to the database.
 */
export type NewTenant = InferInsertModel<typeof tenantModel>

/**
 * The `tenant_settings` table: exactly one row per tenant, created
 * atomically alongside it by `TenantRepository.create()`
 * (tenant.repository.ts). `tenantId` is BOTH the primary key and the
 * foreign key — there is no separate `id` column — which is what makes
 * "one settings row per tenant" a structural guarantee rather than a
 * uniqueness constraint layered on top of an otherwise-independent row:
 * a second settings row for the same tenant is not just discouraged, it is
 * unrepresentable.
 *
 * NO `deletedAt`: this table has no independent lifecycle from its parent
 * `tenants` row (see this file's header comment) — `onDelete: 'cascade'`
 * on the FK is what removes it if the parent is ever hard-deleted, and the
 * parent's own soft-delete already gates visibility of everything scoped
 * to it. `TenantSettingsRepository` does not extend `BaseRepository`
 * accordingly (`SoftDeletableTableConfig` requires a `deletedAt` column
 * this table deliberately has none of).
 */
export const tenantSettingsModel = pgTable('tenant_settings', {
  tenantId: varchar('tenant_id', { length: 36 })
    .primaryKey()
    .references(() => tenantModel.id, { onDelete: 'cascade' }),
  // IANA timezone name (e.g. `America/New_York`) — 64 is comfortably wider
  // than the longest real IANA zone id.
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  // BCP 47 locale tag (e.g. `en`, `en-US`, `pt-BR`) — 10 covers every
  // realistic tag without needing the full grammar's theoretical maximum.
  locale: varchar('locale', { length: 10 }).notNull().default('en'),
  // Extensible per-tenant configuration a derived project can grow without
  // a migration — deliberately unstructured, mirroring `email_logs`'
  // header comment's distinction between columns that need a shape
  // guarantee and ones that don't: nothing in this codebase reads or
  // writes a specific key here, so there is no shape to enforce yet.
  metadata: jsonb('metadata'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A tenant_settings row as read from the database.
 */
export type TenantSettings = InferSelectModel<typeof tenantSettingsModel>

/**
 * A tenant_settings row as written to the database.
 */
export type NewTenantSettings = InferInsertModel<typeof tenantSettingsModel>
