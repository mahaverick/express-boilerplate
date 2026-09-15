// src/database/models/user-token.model.ts
//
// Stores only a HASH of the refresh token — the raw value never reaches the
// database. The raw token is a high-entropy random string
// (crypto.randomBytes(32), see token.utilities.ts), not a user-chosen
// secret, so it is hashed with SHA-256 rather than bcrypt: bcrypt's slow,
// salted design defends against an attacker guessing a low-entropy human
// password, which does not apply to 256 bits of randomness, and bcrypt
// silently truncates its input at 72 bytes — an active hazard for a token
// this long, the same hazard password.utilities.ts guards against for
// passwords. SHA-256 is also deterministic, which is what lets a lookup by
// tokenHash work at all: bcrypt's per-call random salt would hash the same
// input to a different string every time and could never be looked up by
// value.
//
// `sessionId` is the session "family" identifier: every refresh token
// issued at login, and every token rotation produces from it, shares the
// same sessionId for the life of that session — it does not change on
// rotation. That single shared value is what makes both revocation methods
// possible: revoking by sessionId kills one session/device's whole chain in
// one write, and `replacedById` (below) traces which row replaced which
// within that chain, which is what lets reuse detection identify "this
// exact chain was just compromised" rather than only "some token,
// somewhere, was reused".
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { userModel } from '@/database/models/user.model'

/**
 * The `user_tokens` table: one row per issued or rotated-to refresh token.
 * `replacedById` links a rotated-away row to the row that replaced it,
 * tracing a session's full rotation chain — this is what lets
 * `rotateRefreshToken` (token.utilities.ts) tell "this token was already
 * rotated" (reuse) apart from "this token was never issued".
 */
export const userTokenModel = pgTable(
  'user_tokens',
  {
    // uuidv7 is time-ordered, so it indexes like a sequence without leaking
    // a row count the way a serial does — same choice as `users.id`.
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => userModel.id, { onDelete: 'cascade' }),
    sessionId: varchar('session_id', { length: 36 }).notNull(),
    // 64 hex characters = a SHA-256 digest, not the token itself.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set once, either by an explicit revoke (logout, password change) or
    // by rotation claiming this row. Null means "still a live token".
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Self-referencing: the row this one was rotated into. The `():
    // AnyPgColumn` return annotation is required, not decorative — without
    // it TypeScript cannot resolve `userTokenModel`'s own type while this
    // object literal is still being constructed (the standard Drizzle
    // pattern for a self-referencing column).
    replacedById: varchar('replaced_by_id', { length: 36 }).references(
      (): AnyPgColumn => userTokenModel.id
    ),
    // Required only so this table satisfies BaseRepository's
    // SoftDeletableTableConfig bound (base.repository.ts) — a refresh token
    // is retired via `revokedAt`, above, never via soft delete. Nothing in
    // this plan ever sets this column; it is reserved for a possible future
    // retention job that purges very old, already-revoked rows, which is a
    // distinct operation from revocation itself.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A raw token is single-use once rotated and effectively unique by
    // construction (256 bits of randomness) — the unique index is defence
    // in depth against a duplicate hash ever being written, not a
    // load-bearing uniqueness rule the application depends on.
    uniqueIndex('user_tokens_token_hash_unique').on(table.tokenHash),
    // Both revocation paths (revokeSession/revokeAllSessions,
    // token.utilities.ts) filter by exactly one of these columns across
    // potentially many rows; neither is indexed automatically just by
    // virtue of being a foreign key.
    index('user_tokens_session_id_idx').on(table.sessionId),
    index('user_tokens_user_id_idx').on(table.userId),
  ]
)

/**
 * A user_token row as read from the database.
 */
export type UserToken = InferSelectModel<typeof userTokenModel>

/**
 * A user_token row as written to the database.
 */
export type NewUserToken = InferInsertModel<typeof userTokenModel>
