/**
 * @file The `users` table, kept small: every column is one each derived
 * project inherits and has to decide about.
 */
import { isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { boolean, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '@/constants/auth.constants'

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
    /**
     * Null for a federated-only user, who has no password.
     */
    passwordHash: varchar('password_hash', { length: 60 }),
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
