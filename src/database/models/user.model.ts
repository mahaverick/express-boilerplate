// src/database/models/user.model.ts
//
// The shape a new project starts from. Deliberately small: a field nobody
// reads is a field every derived project inherits and has to decide about.
import { isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { boolean, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '@/constants/auth.constants'

/**
 * The `users` table. `emailVerifiedAt` and `lastLoggedInAt` are both live
 * columns, not reserved ones: `UserRepository.markEmailVerified`
 * (`user.repository.ts`) sets `emailVerifiedAt` when a verification token
 * is redeemed, and `login` (`auth.controller.ts`) sets `lastLoggedInAt` on
 * every successful login — see ARCHITECTURE.md's "B3 seam" for the full
 * picture of what B3 wired up.
 */
export const userModel = pgTable(
  'users',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking a
    // row count the way a serial does. Built into Postgres 18 — which is why
    // docker-compose and CI both pin 18.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    // Width shared with the schema that validates an inbound address
    // (auth.validators.ts) rather than written twice — see
    // MAX_EMAIL_LENGTH's own comment for what a disagreement costs.
    email: varchar('email', { length: MAX_EMAIL_LENGTH }).notNull(),
    // Nullable: a federated-identity user (plan B4) has no password.
    passwordHash: varchar('password_hash', { length: 60 }),
    firstName: varchar('first_name', { length: MAX_NAME_LENGTH }),
    lastName: varchar('last_name', { length: MAX_NAME_LENGTH }),
    active: boolean('active').notNull().default(true),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoggedInAt: timestamp('last_logged_in_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness among live accounts only: a soft-deleted
    // user's address can be registered again, and findByEmail's soft-delete
    // scope matches this predicate. Storing email lowercased at the boundary
    // is not enough on its own — two requests racing can both pass a SELECT
    // check and then both INSERT. The database is the only thing that can
    // decide.
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
