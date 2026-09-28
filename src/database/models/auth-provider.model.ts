/**
 * @file The `auth_providers` table: one row per (auth method, external
 * identity) a user can sign in with, so "how can this user log in" is a
 * query rather than a column on `users`.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { AUTH_PROVIDERS, type AuthProvider } from '@/constants/auth-provider.constants'
import { MAX_EMAIL_LENGTH } from '@/constants/auth.constants'
import { userModel } from '@/database/models/user.model'

/**
 * `AUTH_PROVIDERS` as a literal SQL value list, outside the CHECK's template
 * so `sonarjs/no-nested-template-literals` holds.
 */
const AUTH_PROVIDER_SQL_LIST = AUTH_PROVIDERS.map((provider) => `'${provider}'`).join(', ')

/**
 * The `auth_providers` table: one row per auth method a user has, e.g. an
 * `'email'` row for a password-based login and/or a `'google'` row for a
 * linked Google account.
 *
 * Every password sign-up (`register()`) and every Google sign-up writes an
 * `'email'` row (migration 0010 created one for each user with a password),
 * so the unique index covers email identities as well. A Google sign-up's
 * row exists without a password, so `users.password_hash` is the only
 * password signal. No `deletedAt`:
 * nothing un-deletes a login method, so `AuthProviderRepository` does not
 * extend `BaseRepository`, which requires one. No OAuth token columns:
 * nothing calls a Google API for the user, so storing them would keep
 * unused third-party credentials.
 */
export const authProviderModel = pgTable(
  'auth_providers',
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
    /**
     * Also constrained by `auth_providers_provider_check`: a stray value
     * written by raw SQL could never be matched by `findByProviderAndId`.
     */
    provider: varchar('provider', { length: 20 }).$type<AuthProvider>().notNull(),
    /**
     * The email address for `'email'`, or Google's stable profile id for
     * `'google'`. As wide as `users.email`, because `register` writes both in
     * one transaction and a narrower column would 500 on a valid address.
     */
    providerId: varchar('provider_id', { length: MAX_EMAIL_LENGTH }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Security: one row per identity, so two users can never claim the same Google account.
    uniqueIndex('auth_providers_provider_provider_id_unique').on(table.provider, table.providerId),
    index('auth_providers_user_id_idx').on(table.userId),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'auth_providers_provider_check',
      sql`${table.provider} in (${sql.raw(AUTH_PROVIDER_SQL_LIST)})`
    ),
  ]
)

/**
 * An auth_providers row as read from the database.
 */
export type AuthProviderRecord = InferSelectModel<typeof authProviderModel>

/**
 * An auth_providers row as written to the database.
 */
export type NewAuthProvider = InferInsertModel<typeof authProviderModel>
