/**
 * @file The `tenants` table and its one-to-one `tenant_settings` row, kept
 * together because `TenantRepository.create()` writes both in one
 * transaction and neither exists without the other.
 */
import { isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { TENANT_LIFECYCLE_STATES } from '@/constants/tenant.constants'

/**
 * `TENANT_LIFECYCLE_STATES` as a literal SQL value list, outside the CHECK's
 * template so `sonarjs/no-nested-template-literals` holds.
 */
const TENANT_LIFECYCLE_STATE_SQL_LIST = TENANT_LIFECYCLE_STATES.map((state) => `'${state}'`).join(
  ', '
)

/**
 * The `tenants` table: one row per organization, soft-deletable like
 * `users`. `lifecycleState` is separate from `deletedAt`: `archived` goes
 * with a soft delete, while `suspended` only gates access. `findActiveBySlug`
 * (tenant.repository.ts) adds the `active` check to `BaseRepository`'s
 * soft-delete scope. A slug is unique among live tenants only, so an
 * archived tenant's slug can be reclaimed.
 */
export const tenantModel = pgTable(
  'tenants',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: varchar('description', { length: 1000 }),
    /**
     * A URL to the logo; this table never stores binary data.
     */
    logo: varchar('logo', { length: 255 }),
    website: varchar('website', { length: 255 }),
    /**
     * varchar with a CHECK, as for `user_tokens.purpose`, since `$type<>()`
     * binds only TypeScript.
     */
    lifecycleState: varchar('lifecycle_state', { length: 20 })
      .$type<(typeof TENANT_LIFECYCLE_STATES)[number]>()
      .notNull()
      .default('active'),
    /**
     * The one staff tenant. `tenants_single_platform` allows at most one row.
     */
    isPlatform: boolean('is_platform').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenants_slug_unique').on(table.slug).where(isNull(table.deletedAt)),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'tenants_lifecycle_state_check',
      sql`${table.lifecycleState} in (${sql.raw(TENANT_LIFECYCLE_STATE_SQL_LIST)})`
    ),
    uniqueIndex('tenants_single_platform')
      .on(sql`(true)`)
      .where(sql`${table.isPlatform}`),
    // The platform tenant can never be suspended, archived or soft-deleted.
    check(
      'tenants_platform_active',
      sql`not ${table.isPlatform} or (${table.lifecycleState} = 'active' and ${table.deletedAt} is null)`
    ),
    // Trigram indexes for the staff tenant search (needs pg_trgm, migration 0016).
    index('tenants_name_trgm_idx')
      .using('gin', sql`lower(${table.name}) gin_trgm_ops`)
      .where(isNull(table.deletedAt)),
    index('tenants_slug_trgm_idx')
      .using('gin', table.slug.op('gin_trgm_ops'))
      .where(isNull(table.deletedAt)),
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
 * The `tenant_settings` table: exactly one row per tenant, created with it
 * in one transaction by `TenantRepository.create()`. `tenantId` is both the
 * primary key and the foreign key, so a second settings row for a tenant is
 * unrepresentable. No `deletedAt`: the row lives and dies with its tenant
 * (ON DELETE CASCADE), so `TenantSettingsRepository` does not extend
 * `BaseRepository`.
 */
export const tenantSettingsModel = pgTable('tenant_settings', {
  tenantId: varchar('tenant_id', { length: 36 })
    .primaryKey()
    .references(() => tenantModel.id, { onDelete: 'cascade' }),
  /**
   * An IANA timezone name, e.g. `America/New_York`.
   */
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  /**
   * A BCP 47 locale tag, e.g. `en-US`.
   */
  locale: varchar('locale', { length: 10 }).notNull().default('en'),
  /**
   * Unstructured per-tenant configuration a derived project can grow without
   * a migration; no code here reads a specific key.
   */
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
