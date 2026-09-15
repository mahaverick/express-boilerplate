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
// THIS TABLE GROWS WITHOUT BOUND AND NOTHING PRUNES IT. Rotation is
// append-only on purpose — the revoked row has to survive for reuse
// detection to recognise a replay of it — so a client refreshing on a
// 15-minute access TTL writes roughly 96 rows a day, ~2,900 a month, and
// none are ever deleted. No plan owns a retention job; see DATABASE.md's
// "`user_tokens` grows without bound" for what one would do and why it is
// not built here.
//
// `sessionId` is the session "family" identifier: every refresh token
// issued at login, and every token rotation produces from it, shares the
// same sessionId for the life of that session — it does not change on
// rotation. That single shared value is what makes revocation possible at
// all: revoking by sessionId kills one session/device's whole chain in one
// write, which is how both an explicit logout and reuse detection contain a
// session (`revokeAllForSession`, user-token.repository.ts).
//
// `replacedById` is NOT part of that mechanism. Correcting an earlier
// version of this comment, which claimed it "lets reuse detection identify
// this exact chain was compromised": it does not, and nothing in src/ reads
// the column at all — `rotateRefreshToken` writes it and no query ever
// selects it. Reuse detection needs exactly two facts, both of which live
// elsewhere: `revokedAt` on the presented row (a token already revoked, and
// presented again, is a replay) and `sessionId` (which rows to revoke in
// response). What `replacedById` actually is, is FORENSIC METADATA: after
// the fact, it lets a human walk one session's rotation chain in order and
// see which row replaced which. Useful in an incident review, load-bearing
// for nothing at runtime. A plan that wants to build on it should build on
// that description, not on the mechanism claim it used to carry.
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
 *
 * What tells `rotateRefreshToken` (token.utilities.ts) that a token was
 * "already rotated" (reuse) rather than "never issued" is `revokedAt` — the
 * row exists and is already revoked — and what it revokes in response is
 * every row sharing the presented row's `sessionId`. `replacedById` links a
 * rotated-away row to its replacement, but is read by nothing: it is
 * forensic metadata for tracing a chain after the fact. See this file's
 * header comment.
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
    // When the SESSION this token belongs to began — copied forward
    // unchanged by every rotation, never refreshed. `expiresAt` below is a
    // sliding window that each rotation resets, so on its own a client that
    // refreshes normally holds a live session forever and an exfiltrated
    // refresh cookie stays usable until someone logs out. This column is
    // what caps that: `rotateRefreshToken` refuses to rotate once
    // `now() - sessionStartedAt` exceeds SESSION_ABSOLUTE_TTL, however
    // recently the presented token itself was issued.
    //
    // Denormalised rather than derived as `min(created_at) where session_id
    // = $1`, which the existing session_id index would have served without
    // a new column. Two reasons: the derived form makes the cap depend on
    // the oldest row still present, so the retention job this table needs
    // (see this file's header comment on unbounded growth) would silently
    // EXTEND every live session the first time it purged one — a data
    // cleanup task quietly becoming a security regression. And it is read
    // on the rotation path, where a copied column costs nothing and an
    // extra aggregate query per refresh costs a round trip.
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 64 hex characters = a SHA-256 digest, not the token itself.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set once, either by an explicit revoke (logout, password change) or
    // by rotation claiming this row. Null means "still a live token".
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Self-referencing: the row this one was rotated into. Written by
    // `rotateRefreshToken` and read by nothing — forensic metadata, not a
    // mechanism; see this file's header comment before building on it.
    //
    // The `(): AnyPgColumn` return annotation is required, not decorative —
    // without it TypeScript cannot resolve `userTokenModel`'s own type while
    // this object literal is still being constructed (the standard Drizzle
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
