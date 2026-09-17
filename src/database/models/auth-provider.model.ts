// src/database/models/auth-provider.model.ts
//
// One row per (auth method, external identity) pair a user can sign in
// with. A user with one password-based account and a linked Google account
// has two rows here, both pointing at the same `userId` — this table is
// what makes "how many ways can this user log in" a query instead of a
// column on `users` that would need widening every time a new method
// shipped.
//
// NO `access_token`/`refresh_token` COLUMNS — spec correction #1
// (docs/superpowers/plans/2026-09-17-google-oauth.md). Nothing in this
// codebase calls a Google API on this user's behalf or offers a
// revocation endpoint, so storing Google's OAuth tokens here would be
// exactly the "field nobody reads" anti-pattern user.model.ts's own header
// comment warns against — except worse, since these two would be live,
// unencrypted third-party credentials sitting unused. Add them back only
// when a concrete feature reads them.
//
// `provider = 'email'` ROWS EXIST FOR PASSWORD-BASED USERS TOO, not just
// Google. `register()` (auth.controller.ts, wired in Task 4 of
// docs/superpowers/plans/2026-09-17-google-oauth.md) creates one at signup
// (`providerId` = the user's email address), and migration 0010's seed
// backfills one for every pre-existing user that already has a
// `password_hash` (user.model.ts's own header explains why that column is
// nullable: a federated-only user has none). This is deliberate, not
// incidental — it is what lets `findByUser` answer "does this user have a
// password login" without a separate query against `users.password_hash`,
// and what makes the unique constraint below do real work for the email
// provider too (two users can never claim the same email as their login
// identity, mirroring `users_email_unique`).
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { AUTH_PROVIDERS, type AuthProvider } from '@/constants/auth-provider.constants'
import { userModel } from '@/database/models/user.model'

// `AUTH_PROVIDERS`, pre-rendered as a literal SQL value list —
// `'email', 'google'` — for `auth_providers_provider_check` below. Built
// once, here, rather than inline inside that `sql` template: nesting this
// array's own template literal inside the check constraint's `sql\`...\``
// template trips `sonarjs/no-nested-template-literals` — identical reason
// `TOKEN_PURPOSE_SQL_LIST` (user-token.model.ts) is built the same way.
const AUTH_PROVIDER_SQL_LIST = AUTH_PROVIDERS.map((provider) => `'${provider}'`).join(', ')

/**
 * The `auth_providers` table: one row per auth method a user has, e.g. an
 * `'email'` row for a password-based login and/or a `'google'` row for a
 * linked Google account.
 *
 * NO `deletedAt`. Unlinking a provider (were that ever built) would be a
 * hard delete, not a soft one — a stale-but-recoverable row here is not a
 * feature the way it is for `users` (nothing needs to un-delete a login
 * method), which is also why `AuthProviderRepository` does not extend
 * `BaseRepository` (`base.repository.ts`'s `SoftDeletableTableConfig`
 * requires exactly the `deletedAt` column this table deliberately has
 * none of) — see that repository's own header comment.
 */
export const authProviderModel = pgTable(
  'auth_providers',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking
    // a row count the way a serial does — same choice as every other
    // table's id.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    // Which auth method this row is for. Constrained at the database too,
    // not just by TypeScript — `auth_providers_provider_check` below —
    // same argument `user_tokens_purpose_check` (user-token.model.ts)
    // already makes for `purpose`: `$type<T>()` is compile-time narrowing
    // only, and a mis-cased or stray value written by raw SQL could never
    // be matched by `findByProviderAndId` again.
    provider: varchar('provider', { length: 20 }).$type<AuthProvider>().notNull(),
    // The external identity within `provider`'s namespace: the user's own
    // email address for `'email'`, or Google's stable profile id (`sub` /
    // `profile.id`) for `'google'`. 255 chars — wide enough for either, and
    // matches this codebase's other externally-sourced identifier columns
    // (e.g. `email_logs.provider_message_id`).
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The actual login-lookup guarantee: no two rows may claim the same
    // identity within the same provider's namespace — the constraint
    // `findByProviderAndId` depends on returning at most one row, and what
    // stops two users from both claiming, say, the same Google account.
    uniqueIndex('auth_providers_provider_provider_id_unique').on(table.provider, table.providerId),
    // `findByUser` (auth-provider.repository.ts) filters on this column
    // alone across potentially several rows; not indexed automatically
    // just by virtue of being a foreign key.
    index('auth_providers_user_id_idx').on(table.userId),
    // The database-level half of `provider`'s validity check — see that
    // column's own comment, and AUTH_PROVIDERS's header comment for why
    // this table (unlike `notifications.type`) gets a CHECK constraint at
    // all. `sql.raw`, not `sql`-tagged interpolation — a CHECK constraint's
    // expression is fixed at DDL time and has no parameter list to bind
    // against; see `user_tokens_purpose_check`'s own comment
    // (user-token.model.ts) for the verified failure mode of getting this
    // wrong. Safe here for the same reason it is there: every value comes
    // from the fixed, code-defined `AUTH_PROVIDERS` array, never external
    // input.
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
