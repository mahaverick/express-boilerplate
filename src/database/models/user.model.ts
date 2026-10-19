/**
 * @file The `users` table, kept small: every column is one each derived
 * project inherits and has to decide about.
 */
import { isNull, sql, type InferInsertModel, type InferSelectModel, type SQL } from 'drizzle-orm'
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '@/constants/auth.constants'

/**
 * The last sign-in as the `-lastSignIn` sort reads it: never-signed-in as
 * `-infinity`, so it sorts last descending. The list query and its index
 * both call this, so their expressions are the same.
 * @param lastLoggedInAt - The `last_logged_in_at` column.
 * @returns The sort expression.
 */
export function lastSignInSort(lastLoggedInAt: AnyPgColumn | SQL): SQL {
  return sql`coalesce(${lastLoggedInAt}, '-infinity'::timestamptz)`
}

/**
 * The full name as the users search reads it: first and last name joined by a
 * space, trimmed and lowercased, so "ada lovelace" finds the user. Built with
 * `||` and `coalesce` (immutable), so the trigram index can hold it; the list
 * query and its index both call this, so their expressions are the same.
 * @param firstName - The `first_name` column.
 * @param lastName - The `last_name` column.
 * @returns The search expression.
 */
export function userFullNameSearch(firstName: AnyPgColumn | SQL, lastName: AnyPgColumn | SQL): SQL {
  return sql`lower(trim(coalesce(${firstName}, '') || ' ' || coalesce(${lastName}, '')))`
}

/**
 * The `users` table. Email is unique case-insensitively among live accounts
 * only, matching `findByEmail`'s soft-delete scope, so a soft-deleted user's
 * address can register again. `UserRepository.markEmailVerified` sets
 * `emailVerifiedAt` when a verification token is redeemed, and `login`
 * (auth.service.ts) and the Google sign-in (google-auth.service.ts) set
 * `lastLoggedInAt` on every successful sign-in.
 */
export const userModel = pgTable(
  'users',
  {
    /**
     * uuidv7 indexes like a sequence without leaking a row count. Built into
     * Postgres 18, which docker-compose and CI pin.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    email: varchar('email', { length: MAX_EMAIL_LENGTH }).notNull(),
    firstName: varchar('first_name', { length: MAX_NAME_LENGTH }),
    lastName: varchar('last_name', { length: MAX_NAME_LENGTH }),
    active: boolean('active').notNull().default(true),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoggedInAt: timestamp('last_logged_in_at', { withTimezone: true }),
    /**
     * The user turned off browser analytics (`PATCH /profile`). The frontends
     * read it and stop capturing; server events are unaffected.
     */
    analyticsOptOut: boolean('analytics_opt_out').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Concurrency: two racing registrations both pass a SELECT, so only this index decides.
    uniqueIndex('users_email_unique')
      .on(sql`lower(${table.email})`)
      .where(isNull(table.deletedAt)),
    index('users_email_sort_idx').on(sql`lower(${table.email})`, table.id),
    index('users_created_sort_idx').on(table.createdAt, table.id),
    index('users_last_logged_in_sort_idx').on(lastSignInSort(table.lastLoggedInAt), table.id),
    index('users_email_trgm_idx').using('gin', sql`lower(${table.email}) gin_trgm_ops`),
    index('users_first_name_trgm_idx').using('gin', sql`lower(${table.firstName}) gin_trgm_ops`),
    index('users_last_name_trgm_idx').using('gin', sql`lower(${table.lastName}) gin_trgm_ops`),
    index('users_full_name_trgm_idx').using(
      'gin',
      sql`${userFullNameSearch(table.firstName, table.lastName)} gin_trgm_ops`
    ),
  ]
)

/**
 * A user row as read from the database.
 */
export type User = InferSelectModel<typeof userModel>

/**
 * A user row as written to the database.
 */
export type NewUser = InferInsertModel<typeof userModel>
