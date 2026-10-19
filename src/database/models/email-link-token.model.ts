/**
 * @file The `email_link_tokens` table: the single-use links a mail carries,
 * for signing in (`sign_in`) and for confirming a step-up (`step_up`), stored
 * only as SHA-256 hashes, for the reason user-token.model.ts gives. A
 * `sign_in` row is keyed by its address and never names a user, since the
 * click looks the account up by address; a `step_up` row names the user and
 * the session it elevates. `email_link_tokens_shape_check` holds both shapes.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH, MAX_REDIRECT_PATH_LENGTH } from '@/constants/auth.constants'
import { FRONTEND_APPS, type FrontendApp } from '@/constants/frontend.constants'
import { userModel } from '@/database/models/user.model'

/**
 * What a link can do. `LinkTokenIntent` and `email_link_tokens_intent_check`
 * are both built from it, so the type and the constraint cannot drift.
 */
export const LINK_TOKEN_INTENTS = ['sign_in', 'step_up'] as const

/**
 * One of LINK_TOKEN_INTENTS. Every claim is scoped to one intent, so a
 * sign-in link can never confirm a step-up, or the other way around.
 */
export type LinkTokenIntent = (typeof LINK_TOKEN_INTENTS)[number]

/**
 * Render a fixed, code-defined value list as SQL literals for a CHECK.
 * @param values - The allowed values.
 * @returns The values quoted and comma-separated.
 */
function sqlValueList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * The `email_link_tokens` table. A claim stamps `revoked_at` and
 * `consumed_at` together; issuing a new link revokes the live ones it
 * supersedes, which sets `revoked_at` alone. The retention purge deletes a
 * row RETENTION_TOKENS_DAYS after it expired, or after a revoke that never
 * consumed it.
 */
export const emailLinkTokenModel = pgTable(
  'email_link_tokens',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    intent: varchar('intent', { length: 16 }).$type<LinkTokenIntent>().notNull(),
    /**
     * The frontend the link opens. Verify reads it from this row, never from
     * the request, so a link decides which app it signs in to.
     */
    app: varchar('app', { length: 8 }).$type<FrontendApp>().notNull(),
    /**
     * The address the link was mailed to, lowercased by link-token.service.ts.
     */
    email: varchar('email', { length: MAX_EMAIL_LENGTH }).notNull(),
    /**
     * Set on a `step_up` row only; a `sign_in` row's address may have no
     * account yet, and a purged user's address must not reach a new one.
     */
    userId: varchar('user_id', { length: 36 }).references(() => userModel.id, {
      onDelete: 'cascade',
    }),
    /**
     * The session a `step_up` row elevates; null on a `sign_in` row.
     */
    sessionId: varchar('session_id', { length: 36 }),
    /**
     * Where a `sign_in` link lands after verifying: a same-origin path,
     * checked by `redirectPathSchema` before it is stored. Null on a
     * `step_up` row.
     */
    redirect: varchar('redirect', { length: MAX_REDIRECT_PATH_LENGTH }),
    /**
     * A SHA-256 digest in hex, never the token itself.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Set once, by a claim or by a revoke on issuing a newer link. Null means
     * a live link, the one fact the claim's WHERE clause depends on.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * Set only by the claim, with `revokedAt`, so it separates a spent link
     * from one revoked unused.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Defence in depth: 256-bit tokens are unique by construction.
    uniqueIndex('email_link_tokens_token_hash_unique').on(table.tokenHash),
    // The revoke-on-issue of a sign_in link, by address.
    index('email_link_tokens_live_email_idx')
      .on(table.email, table.intent)
      .where(sql`${table.revokedAt} is null`),
    // The revoke-on-issue of a step_up link, by session.
    index('email_link_tokens_user_session_idx').on(table.userId, table.sessionId),
    index('email_link_tokens_expires_at_idx').on(table.expiresAt),
    // Retention: revoked by a newer link, never used.
    index('email_link_tokens_revoked_unconsumed_idx')
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} is not null and ${table.consumedAt} is null`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'email_link_tokens_intent_check',
      sql`${table.intent} in (${sql.raw(sqlValueList(LINK_TOKEN_INTENTS))})`
    ),
    check(
      'email_link_tokens_app_check',
      sql`${table.app} in (${sql.raw(sqlValueList(FRONTEND_APPS))})`
    ),
    check('email_link_tokens_token_hash_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'email_link_tokens_shape_check',
      sql`(${table.intent} = 'sign_in' and ${table.userId} is null and ${table.sessionId} is null) or (${table.intent} = 'step_up' and ${table.userId} is not null and ${table.sessionId} is not null and ${table.redirect} is null)`
    ),
  ]
)

/**
 * An email_link_tokens row as read from the database.
 */
export type EmailLinkToken = InferSelectModel<typeof emailLinkTokenModel>

/**
 * An email_link_tokens row as written to the database.
 */
export type NewEmailLinkToken = InferInsertModel<typeof emailLinkTokenModel>
