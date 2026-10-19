/**
 * @file The `user_tokens` table: refresh, email-verification and
 * password-reset tokens, and the single-use links a mail carries for signing
 * in and confirming a step-up, stored only as SHA-256 hashes. SHA-256, not bcrypt:
 * the token is 256 random bits, so a slow salted hash buys nothing, bcrypt
 * would truncate it at 72 bytes, and a deterministic hash is what makes a
 * lookup by hash possible.
 */
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { MAX_EMAIL_LENGTH, MAX_REDIRECT_PATH_LENGTH } from '@/constants/auth.constants'
import { FRONTEND_APPS, type FrontendApp } from '@/constants/frontend.constants'
import { userModel } from '@/database/models/user.model'

/**
 * The things a `user_tokens` row can be for. `TokenPurpose` and the
 * `user_tokens_purpose_check` constraint are both built from it, so the
 * type and the constraint that stops a raw SQL insert cannot drift.
 */
const TOKEN_PURPOSES = [
  'refresh',
  'email_verification',
  'password_reset',
  'sign_in_link',
  'step_up_link',
] as const

/**
 * `TOKEN_PURPOSES` as a literal SQL value list, outside the CHECK's template
 * so `sonarjs/no-nested-template-literals` holds.
 */
const TOKEN_PURPOSE_SQL_LIST = TOKEN_PURPOSES.map((purpose) => `'${purpose}'`).join(', ')

/**
 * `FRONTEND_APPS` as a literal SQL value list, for `user_tokens_app_check`.
 */
const APP_SQL_LIST = FRONTEND_APPS.map((app) => `'${app}'`).join(', ')

/**
 * What a `user_tokens` row is for. Every claim (`UserTokenRepository.
 * claimOnce`) is scoped to exactly one purpose, so a password-reset token
 * can never be spent as an email verification, or the other way around.
 */
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number]

/**
 * What an emailed link can do: sign in, or confirm a step-up. Each maps to
 * one `user_tokens` purpose (`LINK_TOKEN_PURPOSES`).
 */
export const LINK_TOKEN_INTENTS = ['sign_in', 'step_up'] as const

/**
 * One of LINK_TOKEN_INTENTS.
 */
export type LinkTokenIntent = (typeof LINK_TOKEN_INTENTS)[number]

/**
 * The `user_tokens` purpose each link intent is stored under. A claim is
 * scoped to one purpose, so a sign-in link never confirms a step-up.
 */
export const LINK_TOKEN_PURPOSES = {
  sign_in: 'sign_in_link',
  step_up: 'step_up_link',
} as const satisfies Record<LinkTokenIntent, TokenPurpose>

/**
 * A purpose an emailed link is stored under.
 */
export type LinkTokenPurpose = (typeof LINK_TOKEN_PURPOSES)[LinkTokenIntent]

/**
 * The `user_tokens` table: one row per issued or rotated-to token, for any
 * of the purposes above. `user_tokens_shape_check` holds each purpose's
 * columns: a `sign_in_link` row names an address and no user, since the
 * click looks the account up by address; a `step_up_link` row names the user
 * and the session it elevates; every other row names a user and no address.
 *
 * Rotation is append-only: reuse detection (`rotateRefreshToken`,
 * session.service.ts) needs the revoked row to recognise a replay, and
 * revokes every row sharing its `sessionId` in response. A client refreshing
 * every 15 minutes writes about 96 rows a day; the retention purge deletes a
 * row RETENTION_TOKENS_DAYS after it expired, or after a revoke that never
 * consumed it, and keeps a rotated-away row until it expires.
 */
export const userTokenModel = pgTable(
  'user_tokens',
  {
    /**
     * uuidv7, as for `users.id`.
     */
    id: varchar('id', { length: 36 })
      .primaryKey()
      .default(sql`uuidv7()`),
    /**
     * Null only on a `sign_in_link` row, whose address may have no account
     * yet. The refresh paths read it through `refreshTokenOf`, which narrows
     * it.
     */
    userId: varchar('user_id', { length: 36 }).references(() => userModel.id, {
      onDelete: 'cascade',
    }),
    /**
     * No default, so omitting `purpose` fails to compile rather than minting
     * a refresh-capable row (tests/unit/database/models/user-token.model.test.ts
     * pins this). Also constrained by `user_tokens_purpose_check`, since
     * `$type<T>()` binds only TypeScript.
     */
    purpose: varchar('purpose', { length: 32 }).$type<TokenPurpose>().notNull(),
    /**
     * The session family for a `'refresh'` token, shared by every rotation, so
     * one write revokes a session's whole chain (`revokeAllForSession`). On
     * a `step_up_link` row, the session the link elevates, so a sign-out
     * revokes a pending link with the chain. Null for the other purposes.
     */
    sessionId: varchar('session_id', { length: 36 }),
    /**
     * When the session began, copied forward unchanged by every rotation;
     * `rotateRefreshToken` refuses once it is older than SESSION_ABSOLUTE_TTL.
     * Stored, not derived from the oldest row, because the retention purge
     * would then extend live sessions. Null outside `'refresh'`.
     */
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
    /**
     * When the session last proved who its user is. Set with
     * `sessionStartedAt` when the session starts, copied forward by every
     * rotation, and moved to now on every row of the session by
     * `markSessionReauthenticated` (session.service.ts), so a rotation or a
     * grace-window sibling minted from any row carries the new time. Signed
     * into access tokens as `auth_time` for `requireRecentAuth`
     * (auth.middleware.ts). Null outside `'refresh'`. Null on a refresh row
     * leaves the claim out, which step-up routes treat as stale.
     */
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }),
    /**
     * A SHA-256 digest in hex, never the token itself.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Set once, by an explicit revoke or by `claimOnce`. Null means a live
     * token, the one fact `claimOnce`'s WHERE clause depends on for every
     * purpose.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * Set only by `claimOnce`, with `revokedAt`, so it separates a token spent
     * through its single-use path from one revoked unused. Read by reuse
     * detection's grace and kill checks and by the retention purge.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /**
     * The row this one was rotated into. Written by `rotateRefreshToken` and
     * read by nothing: forensic metadata for walking a chain, which has gaps
     * once the purge deletes a successor (ON DELETE SET NULL). The
     * `AnyPgColumn` annotation lets TypeScript resolve the self-reference.
     */
    replacedById: varchar('replaced_by_id', { length: 36 }).references(
      (): AnyPgColumn => userTokenModel.id,
      { onDelete: 'set null' }
    ),
    /**
     * Only to satisfy `SoftDeletableTableConfig` (base.repository.ts). No
     * path sets it, and the retention purge ignores it.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * The address a link was mailed to, lowercased by link-token.service.ts.
     * Null outside the two link purposes.
     */
    email: varchar('email', { length: MAX_EMAIL_LENGTH }),
    /**
     * The frontend a link opens. Verify reads it from this row, never from the
     * request. Null outside the two link purposes.
     */
    app: varchar('app', { length: 8 }).$type<FrontendApp>(),
    /**
     * Where a `sign_in_link` lands after verifying: a same-origin path checked
     * by `redirectPathSchema` before it is stored. Null otherwise.
     */
    redirect: varchar('redirect', { length: MAX_REDIRECT_PATH_LENGTH }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Defence in depth: 256-bit tokens are unique by construction.
    uniqueIndex('user_tokens_token_hash_unique').on(table.tokenHash),
    index('user_tokens_session_id_idx').on(table.sessionId),
    index('user_tokens_user_id_idx').on(table.userId),
    // The self-reference's ON DELETE SET NULL looks rows up by this column on every delete.
    index('user_tokens_replaced_by_id_idx').on(table.replacedById),
    index('user_tokens_expires_at_idx').on(table.expiresAt),
    // A newly issued sign-in link revokes the live ones of its address.
    index('user_tokens_live_email_idx')
      .on(table.email, table.purpose)
      .where(sql`${table.email} is not null and ${table.revokedAt} is null`),
    // Retention: explicitly revoked, never used (logout, reuse, password change).
    index('user_tokens_revoked_unconsumed_idx')
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} is not null and ${table.consumedAt} is null`),
    // sql.raw: a DDL CHECK cannot take bound parameters; the values are code constants.
    check(
      'user_tokens_purpose_check',
      sql`${table.purpose} in (${sql.raw(TOKEN_PURPOSE_SQL_LIST)})`
    ),
    check('user_tokens_app_check', sql`${table.app} in (${sql.raw(APP_SQL_LIST)})`),
    check(
      'user_tokens_shape_check',
      sql`(${table.purpose} in ('refresh', 'email_verification', 'password_reset') and ${table.userId} is not null and ${table.email} is null and ${table.app} is null and ${table.redirect} is null) or (${table.purpose} = 'sign_in_link' and ${table.userId} is null and ${table.sessionId} is null and ${table.email} is not null and ${table.app} is not null) or (${table.purpose} = 'step_up_link' and ${table.userId} is not null and ${table.sessionId} is not null and ${table.email} is not null and ${table.app} is not null and ${table.redirect} is null)`
    ),
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

/**
 * A `'refresh'` row with the columns its purpose always fills, narrowed by
 * `refreshTokenOf`, so the session paths never handle a null user or session.
 */
export type RefreshUserToken = UserToken & {
  purpose: 'refresh'
  userId: string
  sessionId: string
  sessionStartedAt: Date
}

/**
 * Narrow a row to a refresh token, or nothing. `issueRefreshToken` and
 * rotation always fill the narrowed columns, so a refresh row that lacks one
 * breaks an invariant and is treated as unknown, never as a crash.
 * @param row - Any `user_tokens` row, or undefined.
 * @returns The row as a `RefreshUserToken`, or undefined when it is missing, of another purpose, or incomplete.
 */
export function refreshTokenOf(row: UserToken | undefined): RefreshUserToken | undefined {
  if (row?.purpose !== 'refresh') return undefined
  const { userId, sessionId, sessionStartedAt } = row
  if (userId === null || sessionId === null || sessionStartedAt === null) return undefined
  return { ...row, purpose: 'refresh', userId, sessionId, sessionStartedAt }
}
