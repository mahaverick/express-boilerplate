/**
 * @file The `user_passkeys` table: one row per WebAuthn credential a user
 * has registered, holding the public key and counters the server needs to
 * verify a sign-in. No private key material exists server-side.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { userModel } from '@/database/models/user.model'

/**
 * A Postgres `bytea` column that reads and writes a `Uint8Array`. The driver
 * hands back a `Buffer`; `fromDriver` copies it into a plain `Uint8Array` so
 * callers do not depend on Node's `Buffer`.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/**
 * The `user_passkeys` table: one row per registered passkey. Deleting the
 * user deletes their passkeys. No `deletedAt`: a deleted passkey is gone, so
 * `UserPasskeyRepository` does not extend `BaseRepository`.
 */
export const userPasskeyModel = pgTable(
  'user_passkeys',
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
     * The authenticator's credential ID, base64url. Unique across all users.
     */
    credentialId: text('credential_id').notNull().unique(),
    /**
     * The COSE public key, as the authenticator returned it.
     */
    publicKey: bytea('public_key').notNull(),
    /**
     * The last signature counter seen. A bigint column read as a number: a
     * 32-bit authenticator counter is far below 2^53.
     */
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    /**
     * The transports the authenticator reported, such as `internal` or `hybrid`.
     */
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The authenticator model's AAGUID.
     */
    aaguid: varchar('aaguid', { length: 36 }).notNull(),
    backupEligible: boolean('backup_eligible').notNull(),
    backupState: boolean('backup_state').notNull(),
    /**
     * The name the user sees in their passkey list.
     */
    name: varchar('name', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [index('user_passkeys_user_id_idx').on(table.userId)]
)

/**
 * A user_passkeys row as read from the database.
 */
export type UserPasskeyRecord = InferSelectModel<typeof userPasskeyModel>

/**
 * A user_passkeys row as written to the database.
 */
export type NewUserPasskey = InferInsertModel<typeof userPasskeyModel>
